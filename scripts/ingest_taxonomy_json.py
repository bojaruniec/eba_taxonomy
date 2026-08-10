#!/usr/bin/env python3
"""
ingest_taxonomy_json.py
Parses EBA taxonomy table JSONs (from Full_taxonomy directory or Full_taxonomy.zip)
and exports TaxonomyDatapoint.parquet into out/parquet/ using the local ./duckdb CLI.
"""

import os
import sys
import glob
import json
import time
import zipfile
import subprocess
import tempfile

def main():
    start_time = time.time()
    extracted_dir = "/run/media/piotr/01DCDD09705009D0/Documents and Settings/Piotr/Downloads/Full_taxonomy/Full_taxonomy/www.eba.europa.eu/eu/fr/xbrl/crr/fws"
    zip_path = os.path.join(os.path.dirname(__file__), "..", "docs", "Full_taxonomy.zip")
    output_parquet = os.path.join(os.path.dirname(__file__), "..", "out", "parquet", "TaxonomyDatapoint.parquet")
    duckdb_bin = os.path.join(os.path.dirname(__file__), "..", "duckdb")

    records = []

    if os.path.exists(extracted_dir):
        print(f"Reading taxonomy JSONs from extracted path: {extracted_dir}")
        json_files = glob.glob(os.path.join(extracted_dir, "**/tab/*/*.json"), recursive=True)
        print(f"Found {len(json_files)} taxonomy table JSON files.")
        
        for fpath in json_files:
            try:
                with open(fpath, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    parse_table_json(data, records)
            except Exception as e:
                pass
    elif os.path.exists(zip_path):
        print(f"Reading taxonomy JSONs from zip: {zip_path}")
        with zipfile.ZipFile(zip_path, 'r') as z:
            for item in z.namelist():
                if item.endswith(".json") and "/tab/" in item:
                    try:
                        with z.open(item) as f:
                            data = json.load(f)
                            parse_table_json(data, records)
                    except Exception as e:
                        pass
    else:
        print("Warning: Neither extracted taxonomy directory nor Full_taxonomy.zip found.")
        return

    print(f"Extracted {len(records)} datapoint mapping records in {time.time() - start_time:.2f}s.")

    if not records:
        print("No records extracted.")
        return

    os.makedirs(os.path.dirname(output_parquet), exist_ok=True)
    
    with tempfile.NamedTemporaryFile(mode='w', suffix='.ndjson', delete=False) as tmp:
        tmp_path = tmp.name
        for rec in records:
            tmp.write(json.dumps(rec) + '\n')
            
    print(f"Wrote temporary NDJSON to {tmp_path}. Converting to Parquet via {duckdb_bin}...")
    
    query = f"""
    COPY (
        SELECT 
            DatapointCode::VARCHAR as DatapointCode,
            TemplateCode::VARCHAR as TemplateCode,
            CellID::INTEGER as CellID,
            VariableID::INTEGER as VariableID,
            VariableVID::INTEGER as VariableVID,
            ColumnVID::INTEGER as ColumnVID,
            RowVID::INTEGER as RowVID,
            SheetVID::INTEGER as SheetVID,
            CellCode::VARCHAR as CellCode,
            ValueType::VARCHAR as ValueType
        FROM read_ndjson('{tmp_path}')
    ) TO '{output_parquet}' (FORMAT PARQUET);
    """
    
    subprocess.run([duckdb_bin, "-c", query], check=True)
    os.remove(tmp_path)
    
    print(f"Saved {output_parquet} successfully ({os.path.getsize(output_parquet):,} bytes).")

def parse_table_json(data, records):
    table_templates = data.get("tableTemplates", {})
    for tcode, tdata in table_templates.items():
        pgs = tdata.get("columns", {}).get("datapoint", {}).get("propertyGroups", {})
        for dp_code, dp_obj in pgs.items():
            doc = dp_obj.get("eba:documentation", {})
            if doc:
                records.append({
                    "DatapointCode": dp_code,
                    "TemplateCode": tcode,
                    "CellID": doc.get("CellID"),
                    "VariableID": doc.get("FactVariableID"),
                    "VariableVID": doc.get("FactVariableVersionID"),
                    "ColumnVID": doc.get("ColumnVID"),
                    "RowVID": doc.get("RowVID"),
                    "SheetVID": doc.get("SheetVID"),
                    "CellCode": doc.get("cellcode"),
                    "ValueType": doc.get("type")
                })

if __name__ == "__main__":
    main()
