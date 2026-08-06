/**
 * app.js – EBA Taxonomy Explorer
 * Connects DuckDB-Wasm to Parquet files via HTTP Range Requests,
 * renders results with Tabulator, and provides a live SQL editor.
 */
import { TABLES, PREVIEW_LIMIT, MAX_EXPORT_ROWS } from './config.js';

// ── DuckDB-Wasm CDN bundles ───────────────────────────────────────────────
const DUCKDB_CDN = 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.28.0/dist/';
const BUNDLES = {
  mvp: {
    mainModule: DUCKDB_CDN + 'duckdb-mvp.wasm',
    mainWorker: DUCKDB_CDN + 'duckdb-browser-mvp.worker.js',
  },
  eh: {
    mainModule: DUCKDB_CDN + 'duckdb-eh.wasm',
    mainWorker: DUCKDB_CDN + 'duckdb-browser-eh.worker.js',
  },
};

// ── State ─────────────────────────────────────────────────────────────────
let db = null;
let conn = null;
let tabulator = null;
let activeTable = null;
let customSQL = null;   // null = use default SELECT *, string = user SQL
let fkMap = {};     // stores foreign key definitions

// ── DOM references ────────────────────────────────────────────────────────
const splash = document.getElementById('splash');
const splashStatus = document.getElementById('splash-status');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const tableList = document.getElementById('table-list');
const tableSearch = document.getElementById('table-search');
const tableCount = document.getElementById('table-count');
const tableNameDisp = document.getElementById('table-name-display');
const badgeRows = document.getElementById('badge-rows');
const badgeCols = document.getElementById('badge-cols');
const btnExport = document.getElementById('btn-export');
const sqlToggle = document.getElementById('sql-toggle');
const sqlEditorWrap = document.getElementById('sql-editor-wrap');
const sqlInput = document.getElementById('sql-input');
const btnRun = document.getElementById('btn-run');
const btnReset = document.getElementById('btn-reset');
const sqlError = document.getElementById('sql-error');
const gridLoader = document.getElementById('grid-loader');
const detailPane = document.getElementById('detail-pane');
const btnCloseDp = document.getElementById('btn-close-dp');
const dpTitle = document.getElementById('dp-title');
const dpBody = document.getElementById('dp-body');

const btnInfo = document.getElementById('btn-info');
const infoModal = document.getElementById('info-modal');
const btnCloseModal = document.getElementById('btn-close-modal');
const btnModalOk = document.getElementById('btn-modal-ok');

// ── Utilities ─────────────────────────────────────────────────────────────
const setStatus = (state, msg) => {
  statusDot.className = `status-dot ${state}`;
  statusText.textContent = msg;
};

const showSplash = (msg) => { splashStatus.textContent = msg; splash.style.display = 'flex'; };
const hideSplash = () => { splash.style.display = 'none'; };

const fmt = (n) => n.toLocaleString();

// ── Parquet file name from table name ─────────────────────────────────────
const CACHE_BUSTER = Date.now();
const parquetPath = (name) => new URL(`parquet/${name}.parquet?v=${CACHE_BUSTER}`, document.location.href).href;
const parquetAlias = (name) => `${name}.parquet`;

// ── DuckDB initialisation ─────────────────────────────────────────────────
async function initDuckDB() {
  showSplash('Selecting optimal DuckDB-Wasm bundle…');

  // Dynamically import duckdb-wasm from CDN
  const duckdb = await import(DUCKDB_CDN + 'duckdb-browser.mjs');

  // Pick best bundle based on browser feature detection
  const bundle = await duckdb.selectBundle(BUNDLES);

  showSplash('Starting DuckDB-Wasm worker…');
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' })
  );
  const worker = new Worker(workerUrl);
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
  db = new duckdb.AsyncDuckDB(logger, worker);

  showSplash('Instantiating WASM module…');
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  conn = await db.connect();

  // Enable HTTP range request support (httpfs extension)
  await conn.query(`INSTALL httpfs; LOAD httpfs;`).catch(() => { });

  URL.revokeObjectURL(workerUrl);
}

async function loadFKMap() {
  try {
    await db.registerFileURL('_ForeignKeys.parquet', parquetPath('_ForeignKeys'), 4, false);
    const fkRes = await conn.query("SELECT * FROM read_parquet('_ForeignKeys.parquet')");
    const { rows } = arrowToRows(fkRes);
    rows.forEach(r => {
      // In Jackcess: source is Parent (PK), target is Child (FK)

      // 1) Child -> Parent (FK -> PK navigation)
      if (!fkMap[r.target_table]) fkMap[r.target_table] = {};
      fkMap[r.target_table][r.target_column] = {
        targetTable: r.source_table,
        targetColumn: r.source_column
      };

      // 2) Parent -> Child (PK -> FK navigation)
      // We only register the first child we see to avoid overwriting FK->PK links
      if (!fkMap[r.source_table]) fkMap[r.source_table] = {};
      if (!fkMap[r.source_table][r.source_column]) {
        fkMap[r.source_table][r.source_column] = {
          targetTable: r.target_table,
          targetColumn: r.target_column
        };
      }
    });
  } catch (e) {
    console.warn("Could not load FK map from Parquet:", e);
  }
}

// ── Register + query a Parquet file ──────────────────────────────────────
async function registerTable(name) {
  const url = parquetPath(name);
  const alias = parquetAlias(name);
  // Use HTTP protocol so DuckDB uses Range Requests (works on GitHub Pages)
  await db.registerFileURL(alias, url, 4 /* HTTP */, false);
}

async function runQuery(sql) {
  sqlError.style.display = 'none';
  setStatus('loading', 'Running query…');
  try {
    const result = await conn.query(sql);
    setStatus('ready', 'Ready');
    return result;
  } catch (e) {
    setStatus('error', 'Query error');
    throw e;
  }
}

// ── Convert Arrow result → plain objects for Tabulator ────────────────────
function arrowToRows(result) {
  const cols = result.schema.fields.map(f => f.name);
  const batches = result.batches;
  const rows = [];
  for (const batch of batches) {
    const len = batch.numRows;
    for (let r = 0; r < len; r++) {
      const obj = {};
      cols.forEach((col, i) => {
        const val = batch.getChildAt(i).get(r);
        obj[col] = val === null ? null : String(val);
      });
      rows.push(obj);
    }
  }
  return { cols, rows };
}

// ── Load a table into the grid ────────────────────────────────────────────
window.loadTable = async function loadTable(name, highlightCol = null, highlightVal = null, pushState = true) {
  if (pushState) {
    history.pushState({ type: 'table', name, highlightCol, highlightVal }, '', `#${name}`);
  }
  if (!conn) return;
  activeTable = name;
  customSQL = null;
  sqlInput.value = '';
  detailPane.classList.remove('open');

  // Highlight active item in sidebar
  document.querySelectorAll('.table-item').forEach(el =>
    el.classList.toggle('active', el.dataset.table === name)
  );
  tableNameDisp.textContent = name;
  badgeRows.style.display = 'none';
  badgeCols.style.display = 'none';
  btnExport.disabled = true;

  setStatus('loading', `Loading ${name}…`);
  if (tabulator) tabulator.clearData();
  gridLoader.style.display = 'flex';

  // Force a tiny yield to guarantee the browser repaints the loader before heavy Wasm work
  await new Promise(resolve => setTimeout(resolve, 10));

  try {
    await registerTable(name);
    const alias = parquetAlias(name);

    // Count rows first (cheap metadata read)
    const countRes = await runQuery(`SELECT COUNT(*) AS n FROM read_parquet('${alias}')`);
    const totalRows = Number(countRes.toArray()[0].n);

    // Fetch preview data
    let fetchSql = `SELECT * FROM read_parquet('${alias}')`;
    if (highlightCol && highlightVal !== null) {
      const safeVal = String(highlightVal).replace(/'/g, "''");
      fetchSql += ` ORDER BY ("${highlightCol}" = '${safeVal}') DESC`;
    }
    fetchSql += ` LIMIT ${PREVIEW_LIMIT}`;

    const dataRes = await runQuery(fetchSql);
    const { cols, rows } = arrowToRows(dataRes);

    renderGrid(cols, rows);

    if (highlightCol && highlightVal !== null) {
      setTimeout(() => {
        if (!tabulator) return;
        const targetRow = tabulator.getRows().find(r => String(r.getData()[highlightCol]) === String(highlightVal));
        if (targetRow) {
          tabulator.deselectRow();
          targetRow.select();
          targetRow.scrollTo();
        }
      }, 50);
    }

    badgeRows.textContent = `${fmt(totalRows)} rows${totalRows > PREVIEW_LIMIT ? ` (showing ${fmt(PREVIEW_LIMIT)})` : ''}`;
    badgeRows.style.display = '';
    badgeCols.textContent = `${cols.length} cols`;
    badgeCols.style.display = '';
    btnExport.disabled = false;

    // Pre-fill SQL editor with the default query
    if (!sqlInput.value) {
      sqlInput.value = `SELECT *\nFROM read_parquet('${alias}')\nLIMIT ${PREVIEW_LIMIT}`;
    }

    setStatus('ready', 'Ready');
  } catch (e) {
    setStatus('error', e.message);
    console.error(e);
  } finally {
    gridLoader.style.display = 'none';
  }
}

// ── Render Tabulator grid ─────────────────────────────────────────────────
function renderGrid(cols, rows) {
  const columns = cols.map(col => ({
    title: col,
    field: col,
    minWidth: 100,
    maxWidth: 400,
    headerFilter: "input",
    formatter: (cell) => {
      const v = cell.getValue();
      let html = v === null || v === 'null' ? `<span style="color:var(--text-3);font-style:italic">null</span>` : v;
      // Visually indicate FK links
      if (fkMap[activeTable] && fkMap[activeTable][col]) {
        html = `<span style="color:var(--accent); cursor:pointer; text-decoration:underline;">${html}</span>`;
      }
      return html;
    },
    cellClick: (e, cell) => {
      const val = cell.getValue();
      if (val === null || val === 'null' || !val) return;
      if (fkMap[activeTable] && fkMap[activeTable][col]) {
        const target = fkMap[activeTable][col];
        openDetailPane(target.targetTable, target.targetColumn, val);
      }
    }
  }));

  if (tabulator) {
    tabulator.clearHeaderFilter();
    tabulator.setColumns(columns);
    tabulator.setData(rows);
    return;
  }

  tabulator = new Tabulator('#data-grid', {
    data: rows,
    columns,
    layout: 'fitData',
    pagination: 'local',
    paginationSize: 100,
    paginationSizeSelector: [50, 100, 250, 500],
    movableColumns: true,
    selectableRows: true,
    tooltips: true,
    height: '100%',
    placeholder: '<span style="color:var(--text-3)">Select a table from the sidebar</span>',
  });
}

// ── Detail Pane (FK Inspector) ────────────────────────────────────────────
async function openDetailPane(table, column, value, pushState = true) {
  if (pushState) {
    history.pushState({ type: 'detail', table, column, value }, '', `#${table}-detail`);
  }
  detailPane.classList.add('open');
  dpTitle.textContent = `${table} (Loading...)`;
  dpBody.innerHTML = '<div class="spinner" style="margin: 20px auto;"></div>';

  try {
    await registerTable(table);
    const sql = `SELECT * FROM read_parquet('${parquetAlias(table)}') WHERE "${column}" = '${value.replace(/'/g, "''")}' LIMIT 1`;
    const res = await conn.query(sql);
    const { cols, rows } = arrowToRows(res);

    if (rows.length === 0) {
      dpBody.innerHTML = '<div style="color:var(--text-3); text-align:center; padding: 20px;">Record not found.</div>';
      dpTitle.textContent = table;
      return;
    }

    const row = rows[0];
    let html = '<table class="prop-table"><tbody>';
    cols.forEach(c => {
      const v = row[c] === null ? '<span style="color:var(--text-3);font-style:italic">null</span>' : row[c];
      html += `<tr><th>${c}</th><td>${v}</td></tr>`;
    });
    html += '</tbody></table>';

    dpBody.innerHTML = html;
    dpTitle.innerHTML = `<span style="color:var(--accent); cursor:pointer; text-decoration:underline;" onclick="loadTable('${table}', '${column}', '${value.replace(/'/g, "\\'")}')" title="Load ${table} in main window">${table}</span> &mdash; Referenced by ${column} = ${value}`;
  } catch (e) {
    dpBody.innerHTML = `<div class="error-msg" style="padding: 20px;">${e.message}</div>`;
  }
}

// ── SQL editor ────────────────────────────────────────────────────────────
async function runCustomSQL() {
  const sql = sqlInput.value.trim();
  if (!sql) return;

  sqlError.style.display = 'none';
  setStatus('loading', 'Running query…');

  try {
    const result = await conn.query(sql);
    const { cols, rows } = arrowToRows(result);
    renderGrid(cols, rows);
    customSQL = sql;

    badgeRows.textContent = `${fmt(rows.length)} rows`;
    badgeRows.style.display = '';
    badgeCols.textContent = `${cols.length} cols`;
    badgeCols.style.display = '';
    setStatus('ready', 'Query complete');
  } catch (e) {
    sqlError.textContent = e.message;
    sqlError.style.display = 'block';
    setStatus('error', 'Query error');
  }
}

// ── CSV export ────────────────────────────────────────────────────────────
async function exportCSV() {
  if (!activeTable) return;
  btnExport.disabled = true;
  setStatus('loading', 'Exporting…');

  try {
    const alias = parquetAlias(activeTable);
    const sql = customSQL || `SELECT * FROM read_parquet('${alias}') LIMIT ${MAX_EXPORT_ROWS}`;
    const result = await conn.query(sql);
    const { cols, rows } = arrowToRows(result);

    const header = cols.join(',');
    const body = rows.map(r =>
      cols.map(c => {
        const v = r[c] ?? '';
        return v.includes(',') || v.includes('"') || v.includes('\n')
          ? `"${v.replace(/"/g, '""')}"` : v;
      }).join(',')
    ).join('\n');

    const blob = new Blob([header + '\n' + body], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${activeTable}.csv`; a.click();
    URL.revokeObjectURL(url);
    setStatus('ready', `Exported ${fmt(rows.length)} rows`);
  } catch (e) {
    setStatus('error', e.message);
  } finally {
    btnExport.disabled = false;
  }
}

// ── Sidebar ───────────────────────────────────────────────────────────────
function buildSidebar(filter = '') {
  const q = filter.toLowerCase();
  const shown = TABLES.filter(t => t.toLowerCase().includes(q));
  tableCount.textContent = `${shown.length} / ${TABLES.length} tables`;

  tableList.innerHTML = '';
  shown.forEach(name => {
    const div = document.createElement('div');
    div.className = 'table-item';
    div.dataset.table = name;
    if (name === activeTable) div.classList.add('active');
    div.innerHTML = `<span class="ti-icon">▦</span>${name}`;
    div.addEventListener('click', () => loadTable(name));
    tableList.appendChild(div);
  });
}

// ── Event wiring ──────────────────────────────────────────────────────────
tableSearch.addEventListener('input', (e) => buildSidebar(e.target.value));

sqlToggle.addEventListener('click', () => {
  const open = sqlEditorWrap.classList.toggle('open');
  sqlToggle.classList.toggle('open', open);
});

btnRun.addEventListener('click', runCustomSQL);
sqlInput.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') runCustomSQL();
});

btnReset.addEventListener('click', () => {
  customSQL = null;
  sqlError.style.display = 'none';
  if (activeTable) loadTable(activeTable);
});

btnExport.addEventListener('click', exportCSV);

btnInfo.addEventListener('click', () => infoModal.classList.add('open'));
btnCloseModal.addEventListener('click', () => infoModal.classList.remove('open'));
btnModalOk.addEventListener('click', () => infoModal.classList.remove('open'));
infoModal.addEventListener('click', (e) => {
  if (e.target === infoModal) infoModal.classList.remove('open');
});
btnCloseDp.addEventListener('click', () => detailPane.classList.remove('open'));

// ── Bootstrap ─────────────────────────────────────────────────────────────
(async () => {
  try {
    await initDuckDB();
    await loadFKMap();
    buildSidebar();
    hideSplash();
    setStatus('ready', 'Ready — select a table');

    // Auto-load table from hash or first table
    const hash = window.location.hash.replace('#', '');
    if (hash && !hash.endsWith('-detail')) {
      // Use replaceState for the initial load so we don't pollute history
      history.replaceState({ type: 'table', name: hash, highlightCol: null, highlightVal: null }, '', `#${hash}`);
      loadTable(hash, null, null, false);
    } else if (TABLES.length > 0) {
      history.replaceState({ type: 'table', name: TABLES[0], highlightCol: null, highlightVal: null }, '', `#${TABLES[0]}`);
      loadTable(TABLES[0], null, null, false);
    }
    
    // Listen for browser Back/Forward
    window.addEventListener('popstate', (e) => {
      const state = e.state;
      if (!state) {
        detailPane.classList.remove('open');
        return;
      }
      if (state.type === 'table') {
        loadTable(state.name, state.highlightCol, state.highlightVal, false);
      } else if (state.type === 'detail') {
        openDetailPane(state.table, state.column, state.value, false);
      }
    });
  } catch (e) {
    splashStatus.textContent = `Init failed: ${e.message}`;
    statusDot.className = 'status-dot error';
    statusText.textContent = 'Failed';
    console.error('DuckDB init error:', e);
  }
})();