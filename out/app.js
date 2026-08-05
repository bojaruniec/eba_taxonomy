/**
 * app.js – EBA Taxonomy Explorer
 * Connects DuckDB-Wasm to Parquet files via HTTP Range Requests,
 * renders results with Tabulator, and provides a live SQL editor.
 */
import { TABLES, PREVIEW_LIMIT, MAX_EXPORT_ROWS } from './config.js';

// ── DuckDB-Wasm CDN bundles ───────────────────────────────────────────────
const DUCKDB_CDN  = 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.28.0/dist/';
const BUNDLES = {
  mvp: {
    mainModule:   DUCKDB_CDN + 'duckdb-mvp.wasm',
    mainWorker:   DUCKDB_CDN + 'duckdb-browser-mvp.worker.js',
  },
  eh: {
    mainModule:   DUCKDB_CDN + 'duckdb-eh.wasm',
    mainWorker:   DUCKDB_CDN + 'duckdb-browser-eh.worker.js',
  },
};

// ── State ─────────────────────────────────────────────────────────────────
let db          = null;
let conn        = null;
let tabulator   = null;
let activeTable = null;
let customSQL   = null;   // null = use default SELECT *, string = user SQL

// ── DOM references ────────────────────────────────────────────────────────
const splash        = document.getElementById('splash');
const splashStatus  = document.getElementById('splash-status');
const statusDot     = document.getElementById('status-dot');
const statusText    = document.getElementById('status-text');
const tableList     = document.getElementById('table-list');
const tableSearch   = document.getElementById('table-search');
const tableCount    = document.getElementById('table-count');
const tableNameDisp = document.getElementById('table-name-display');
const badgeRows     = document.getElementById('badge-rows');
const badgeCols     = document.getElementById('badge-cols');
const btnExport     = document.getElementById('btn-export');
const sqlToggle     = document.getElementById('sql-toggle');
const sqlEditorWrap = document.getElementById('sql-editor-wrap');
const sqlInput      = document.getElementById('sql-input');
const btnRun        = document.getElementById('btn-run');
const btnReset      = document.getElementById('btn-reset');
const sqlError      = document.getElementById('sql-error');

const btnInfo       = document.getElementById('btn-info');
const infoModal     = document.getElementById('info-modal');
const btnCloseModal = document.getElementById('btn-close-modal');
const btnModalOk    = document.getElementById('btn-modal-ok');

// ── Utilities ─────────────────────────────────────────────────────────────
const setStatus = (state, msg) => {
  statusDot.className = `status-dot ${state}`;
  statusText.textContent = msg;
};

const showSplash = (msg) => { splashStatus.textContent = msg; splash.style.display = 'flex'; };
const hideSplash = ()    => { splash.style.display = 'none'; };

const fmt = (n) => n.toLocaleString();

// ── Parquet file name from table name ─────────────────────────────────────
// DuckDB-Wasm worker runs from a blob: URL. We MUST provide absolute URLs for XHR.
const parquetPath = (name) => new URL(`./parquet/${name}.parquet`, document.location.href).href;
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
  await conn.query(`INSTALL httpfs; LOAD httpfs;`).catch(() => {});

  URL.revokeObjectURL(workerUrl);
}

// ── Register + query a Parquet file ──────────────────────────────────────
async function registerTable(name) {
  const url   = parquetPath(name);
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
  const cols   = result.schema.fields.map(f => f.name);
  const batches = result.batches;
  const rows   = [];
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
async function loadTable(name) {
  if (!conn) return;
  activeTable = name;
  customSQL   = null;
  sqlInput.value = '';

  // Highlight active item in sidebar
  document.querySelectorAll('.table-item').forEach(el =>
    el.classList.toggle('active', el.dataset.table === name)
  );
  tableNameDisp.textContent = name;
  badgeRows.style.display = 'none';
  badgeCols.style.display = 'none';
  btnExport.disabled = true;

  setStatus('loading', `Loading ${name}…`);

  try {
    await registerTable(name);
    const alias = parquetAlias(name);

    // Count rows first (cheap metadata read)
    const countRes = await runQuery(`SELECT COUNT(*) AS n FROM read_parquet('${alias}')`);
    const totalRows = Number(countRes.toArray()[0].n);

    // Fetch preview data
    const dataRes = await runQuery(
      `SELECT * FROM read_parquet('${alias}') LIMIT ${PREVIEW_LIMIT}`
    );
    const { cols, rows } = arrowToRows(dataRes);

    renderGrid(cols, rows);

    badgeRows.textContent = `${fmt(totalRows)} rows${totalRows > PREVIEW_LIMIT ? ` (showing ${fmt(PREVIEW_LIMIT)})` : ''}`;
    badgeRows.style.display = '';
    badgeCols.textContent  = `${cols.length} cols`;
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
  }
}

// ── Render Tabulator grid ─────────────────────────────────────────────────
function renderGrid(cols, rows) {
  const columns = cols.map(col => ({
    title:     col,
    field:     col,
    minWidth:  100,
    maxWidth:  400,
    headerFilter: "input",
    formatter: (cell) => {
      const v = cell.getValue();
      if (v === null || v === 'null') return `<span style="color:var(--text-3);font-style:italic">null</span>`;
      return v;
    },
  }));

  if (tabulator) {
    tabulator.clearHeaderFilter();
    tabulator.setColumns(columns);
    tabulator.setData(rows);
    return;
  }

  tabulator = new Tabulator('#data-grid', {
    data:            rows,
    columns,
    layout:          'fitData',
    pagination:      'local',
    paginationSize:  100,
    paginationSizeSelector: [50, 100, 250, 500],
    movableColumns:  true,
    tooltips:        true,
    height:          '100%',
    placeholder:     '<span style="color:var(--text-3)">Select a table from the sidebar</span>',
  });
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
    badgeCols.textContent  = `${cols.length} cols`;
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
    const sql   = customSQL || `SELECT * FROM read_parquet('${alias}') LIMIT ${MAX_EXPORT_ROWS}`;
    const result = await conn.query(sql);
    const { cols, rows } = arrowToRows(result);

    const header = cols.join(',');
    const body   = rows.map(r =>
      cols.map(c => {
        const v = r[c] ?? '';
        return v.includes(',') || v.includes('"') || v.includes('\n')
          ? `"${v.replace(/"/g, '""')}"` : v;
      }).join(',')
    ).join('\n');

    const blob = new Blob([header + '\n' + body], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
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
  const q      = filter.toLowerCase();
  const shown  = TABLES.filter(t => t.toLowerCase().includes(q));
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

// ── Bootstrap ─────────────────────────────────────────────────────────────
(async () => {
  try {
    await initDuckDB();
    buildSidebar();
    hideSplash();
    setStatus('ready', 'Ready — select a table');

    // Auto-load first table
    if (TABLES.length > 0) loadTable(TABLES[0]);
  } catch (e) {
    splashStatus.textContent = `Init failed: ${e.message}`;
    statusDot.className = 'status-dot error';
    statusText.textContent = 'Failed';
    console.error('DuckDB init error:', e);
  }
})();
