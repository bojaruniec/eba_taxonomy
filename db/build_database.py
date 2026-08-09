import re
import os
import duckdb
from collections import defaultdict, deque

TABLES_SQL_PATH = '../out/schema/tables.sql'
PARQUET_DIR = '../out/parquet'
DB_PATH = 'eba_taxonomy.duckdb'

def parse_tables(filepath):
    """
    Parses tables.sql and returns a dict mapping table_name to its columns DDL string.
    """
    tables = {}
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    
    pattern = re.compile(r'CREATE TABLE "([^"]+)" \((.*?)\);', re.DOTALL)
    for match in pattern.finditer(content):
        table_name = match.group(1)
        columns_ddl = match.group(2)
        tables[table_name] = columns_ddl
    return tables

def get_fks():
    """
    Reads _ForeignKeys.parquet and returns a list of hard constraints.
    """
    fks = []
    # Read Parquet using an in-memory DuckDB instance
    con = duckdb.connect(':memory:')
    parquet_path = os.path.join(PARQUET_DIR, '_ForeignKeys.parquet')
    
    # We only care about is_enforced = True
    rows = con.execute(f"SELECT source_table, source_column, target_table, target_column FROM read_parquet('{parquet_path}') WHERE is_enforced = true").fetchall()
    
    for row in rows:
        # Jackcess source = PK (Parent), target = FK (Child)
        parent_table = row[0]
        parent_col = row[1]
        child_table = row[2]
        child_col = row[3]
        
        # USER OVERRIDE: Break the cycle by dropping the Organisation -> Concept constraint.
        # Organisation will be created first as a dictionary table.
        if child_table == 'Organisation' and parent_table == 'Concept':
            continue
            
        fks.append({
            'child_table': child_table,
            'child_col': child_col,
            'parent_table': parent_table,
            'parent_col': parent_col
        })
    return fks

def topological_sort(tables, fks):
    graph = defaultdict(list)
    in_degree = {t: 0 for t in tables.keys()}
    
    for fk in fks:
        p = fk['parent_table']
        c = fk['child_table']
        if p != c:
            if p in tables and c in tables:
                graph[p].append(c)
                in_degree[c] += 1
                
    queue = deque([t for t in in_degree if in_degree[t] == 0])
    sorted_tables = []
    
    while queue:
        node = queue.popleft()
        sorted_tables.append(node)
        for neighbor in graph[node]:
            in_degree[neighbor] -= 1
            if in_degree[neighbor] == 0:
                queue.append(neighbor)
                
    if len(sorted_tables) != len(tables):
        print(f"Warning: Cycle detected! Sorted {len(sorted_tables)} out of {len(tables)} tables.")
        # If there are cycles, DuckDB cannot build it. We'll still append the rest.
        for t in tables:
            if t not in sorted_tables:
                sorted_tables.append(t)
                
    return sorted_tables

def build_database():
    print("Parsing schemas...")
    tables = parse_tables(TABLES_SQL_PATH)
    
    print("Loading foreign keys...")
    fks = get_fks()
    
    parent_unique_cols = defaultdict(set)
    for fk in fks:
        parent_unique_cols[fk['parent_table']].add(fk['parent_col'])
        
    child_fks = defaultdict(list)
    for fk in fks:
        clause = f'FOREIGN KEY ("{fk["child_col"]}") REFERENCES "{fk["parent_table"]}" ("{fk["parent_col"]}")'
        child_fks[fk['child_table']].append(clause)
        
    sorted_tables = topological_sort(tables, fks)
    
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)
        
    print(f"Building DuckDB database at {DB_PATH}...")
    con = duckdb.connect(DB_PATH)
    
    for t in sorted_tables:
        print(f"Creating table {t}...")
        columns_ddl = tables[t].strip()
        clauses = [columns_ddl]
        
        for ucol in parent_unique_cols.get(t, []):
            clauses.append(f'UNIQUE ("{ucol}")')
            
        for fk_clause in child_fks.get(t, []):
            clauses.append(fk_clause)
            
        final_ddl = f'CREATE TABLE "{t}" (\n    ' + ',\n    '.join(clauses) + '\n);'
        
        try:
            con.execute(final_ddl)
        except Exception as e:
            print(f"Error creating table {t}:\n{final_ddl}")
            raise e
            
        parquet_path = os.path.join(PARQUET_DIR, f"{t}.parquet")
        if os.path.exists(parquet_path):
            print(f"  Loading data into {t}...")
            try:
                con.execute(f'INSERT INTO "{t}" SELECT * FROM read_parquet(\'{parquet_path}\')')
            except Exception as e:
                print(f"Error inserting data into {t}: {e}")
                
    con.close()
    print("Database built successfully!")

if __name__ == '__main__':
    build_database()
