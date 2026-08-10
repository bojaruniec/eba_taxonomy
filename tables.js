// Global App State
let db = null;
let conn = null;
let currentReleaseID = null;
let currentModuleVID = 489; // Default CODIS
let currentTableVID = null;
let currentSheetHeaderID = null;
let viewMode = 'compact'; // 'compact' | 'detailed'
let reportData = new Map(); // dpId -> factValue
let reportMeta = null;
let currentTables = [];
let reportedTablesSet = new Set();

// DOM Elements
const splash = document.getElementById('splash');
const splashStatus = document.getElementById('splash-status');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const releaseSelect = document.getElementById('release-select');
const moduleSelect = document.getElementById('module-select');
const tableSearch = document.getElementById('table-search');
const tableList = document.getElementById('table-list');
const tableCount = document.getElementById('table-count');
const btnViewMode = document.getElementById('btn-view-mode');
const tableCodeDisplay = document.getElementById('table-code-display');
const tableTitleDisplay = document.getElementById('table-title-display');
const badgeRows = document.getElementById('badge-rows');
const badgeCols = document.getElementById('badge-cols');
const sheetTabsWrap = document.getElementById('sheet-tabs-wrap');
const sheetTabs = document.getElementById('sheet-tabs');
const tableContainer = document.getElementById('table-container');
const gridLoader = document.getElementById('grid-loader');
const gridLoaderText = document.getElementById('grid-loader-text');
const detailPane = document.getElementById('detail-pane');
const dpBody = document.getElementById('dp-body');
const btnCloseDp = document.getElementById('btn-close-dp');
const infoModal = document.getElementById('info-modal');
const btnInfo = document.getElementById('btn-info');
const btnCloseModal = document.getElementById('btn-close-modal');
const btnModalOk = document.getElementById('btn-modal-ok');
const btnLoadReport = document.getElementById('btn-load-report');
const reportFileInput = document.getElementById('report-file-input');
const reportBanner = document.getElementById('report-banner');
const reportBannerMeta = document.getElementById('report-banner-meta');
const btnClearReport = document.getElementById('btn-clear-report');

// Parquet files to register
const PARQUET_FILES = [
  'Framework.parquet',
  'Module.parquet',
  'ModuleVersion.parquet',
  'ModuleVersionComposition.parquet',
  'TableVersion.parquet',
  'TableVersionHeader.parquet',
  'HeaderVersion.parquet',
  'Header.parquet',
  'TableVersionCell.parquet',
  'Cell.parquet',
  'VariableVersion.parquet',
  'Release.parquet',
  'Property.parquet',
  'Item.parquet',
  'ItemCategory.parquet',
  'Context.parquet',
  'ContextComposition.parquet',
  'Category.parquet'
];

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

// Initialize Application
async function init() {
  try {
    updateSplash('Selecting optimal DuckDB-Wasm bundle…');
    const duckdb = await import(DUCKDB_CDN + 'duckdb-browser.mjs');
    const bundle = await duckdb.selectBundle(BUNDLES);

    updateSplash('Starting DuckDB-Wasm worker…');
    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' })
    );
    const worker = new Worker(workerUrl);
    const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
    db = new duckdb.AsyncDuckDB(logger, worker);

    updateSplash('Instantiating WASM module…');
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    conn = await db.connect();
    URL.revokeObjectURL(workerUrl);

    updateSplash('Registering Parquet files…');
    const baseUrl = window.location.href.substring(0, window.location.href.lastIndexOf('/') + 1);
    for (const f of PARQUET_FILES) {
      const fileUrl = `${baseUrl}parquet/${f}`;
      await db.registerFileURL(f, fileUrl, duckdb.DuckDBDataProtocol.HTTP, false);
    }

    setStatus('Ready', 'ready');
    splash.classList.add('hidden');

    await loadReleases();
    setupEventListeners();

  } catch (err) {
    console.error('Initialisation failed:', err);
    updateSplash(`Error: ${err.message}`);
    setStatus('Error', 'error');
  }
}

function updateSplash(msg) {
  if (splashStatus) splashStatus.textContent = msg;
}

function setStatus(text, state) {
  if (statusText) statusText.textContent = text;
  if (statusDot) {
    statusDot.className = 'status-dot';
    if (state) statusDot.classList.add(state);
  }
}

function showToast(msg) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// -------------------------------------------------------------
// Data Loaders
// -------------------------------------------------------------

async function loadReleases() {
  const res = await conn.query(`
    SELECT ReleaseID, Code, Date, Description 
    FROM 'Release.parquet' 
    ORDER BY ReleaseID DESC;
  `);
  const releases = res.toArray().map(r => r.toJSON());

  releaseSelect.innerHTML = '';
  releases.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r.ReleaseID;
    opt.textContent = `Release ${r.Code} (${r.Date || 'Draft'})`;
    releaseSelect.appendChild(opt);
  });

  // Default to 4.2 (ReleaseID 5) if present, else first
  const rel42 = releases.find(r => r.Code === '4.2');
  currentReleaseID = rel42 ? rel42.ReleaseID : (releases[0]?.ReleaseID || null);
  releaseSelect.value = currentReleaseID;

  await loadModules();
}

async function loadModules() {
  const res = await conn.query(`
    SELECT DISTINCT mv.ModuleVID, mv.Code, mv.Name, f.Code AS FrameworkCode
    FROM 'ModuleVersion.parquet' mv
    JOIN 'Module.parquet' m ON m.ModuleID = mv.ModuleID
    JOIN 'Framework.parquet' f ON f.FrameworkID = m.FrameworkID
    WHERE (mv.EndReleaseID IS NULL OR mv.EndReleaseID >= ${currentReleaseID})
      AND mv.StartReleaseID <= ${currentReleaseID}
    ORDER BY f.Code, mv.Code;
  `);
  const modules = res.toArray().map(r => r.toJSON());

  moduleSelect.innerHTML = '';
  modules.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.ModuleVID;
    opt.textContent = `${m.FrameworkCode} — ${m.Code} (${m.Name || 'Module'})`;
    moduleSelect.appendChild(opt);
  });

  // Default to CODIS (489) if present
  const codis = modules.find(m => m.Code === 'CODIS');
  currentModuleVID = codis ? codis.ModuleVID : (modules[0]?.ModuleVID || null);
  moduleSelect.value = currentModuleVID;

  await loadTableList();
}

async function loadTableList() {
  if (!currentModuleVID) return;

  const res = await conn.query(`
    SELECT mvc."Order" AS TableOrder, tv.TableVID, tv.Code AS TableCode, 
           COALESCE(NULLIF(tv.Description, ''), NULLIF(tv.Name, ''), tv.Code) AS Description
    FROM 'ModuleVersionComposition.parquet' mvc
    JOIN 'TableVersion.parquet' tv ON tv.TableVID = mvc.TableVID
    WHERE mvc.ModuleVID = ${currentModuleVID}
    ORDER BY tv.Code, mvc."Order";
  `);
  currentTables = res.toArray().map(r => r.toJSON());

  // Natural sort by TableCode (e.g. K_01.00, K_01.00.a, K_01.00.b, K_02.00)
  currentTables.sort((a, b) => a.TableCode.localeCompare(b.TableCode, undefined, { numeric: true, sensitivity: 'base' }));

  renderTableList(currentTables);
}

function renderTableList(tables) {
  tableList.innerHTML = '';
  const filter = tableSearch.value.trim().toLowerCase();

  const filtered = tables.filter(t => 
    !filter || 
    t.TableCode.toLowerCase().includes(filter) || 
    (t.Description && t.Description.toLowerCase().includes(filter))
  );

  tableCount.textContent = `${filtered.length} of ${tables.length} tables`;

  filtered.forEach(t => {
    const item = document.createElement('div');
    item.className = 'table-item';

    // Sub-table indentation (e.g. K_04.00.a under K_04.00)
    const isSubtable = t.TableCode.split('.').length > 2;
    if (isSubtable) {
      item.classList.add('subtable-item');
    }

    if (t.TableVID === currentTableVID) item.classList.add('active');

    const code = document.createElement('div');
    code.className = 'table-item-code';
    code.textContent = t.TableCode;

    // Check if table is reported in loaded report package
    const isReported = reportedTablesSet.has(t.TableCode) || 
                       reportedTablesSet.has(t.TableCode.replace(/\.[a-z]$/i, ''));
    if (isReported) {
      const repBadge = document.createElement('span');
      repBadge.className = 'table-reported-badge';
      repBadge.textContent = '● Reported';
      code.appendChild(repBadge);
    }

    const desc = document.createElement('div');
    desc.className = 'table-item-desc';
    desc.textContent = t.Description || '';

    item.appendChild(code);
    item.appendChild(desc);

    item.addEventListener('click', () => {
      document.querySelectorAll('.table-item').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
      currentTableVID = t.TableVID;
      loadTableLayout(t.TableVID, t.TableCode, t.Description);
    });

    tableList.appendChild(item);
  });

  // Auto-select first table if none selected
  if (!currentTableVID && filtered.length > 0) {
    const first = filtered[0];
    currentTableVID = first.TableVID;
    const firstItem = tableList.querySelector('.table-item');
    if (firstItem) firstItem.classList.add('active');
    loadTableLayout(first.TableVID, first.TableCode, first.Description);
  }
}

// -------------------------------------------------------------
// Table Grid Layout Renderer
// -------------------------------------------------------------

async function loadTableLayout(tableVid, code, desc) {
  showGridLoader('Fetching layout headers & cells…');

  tableCodeDisplay.textContent = code || '—';
  tableTitleDisplay.textContent = desc || '';

  try {
    // 1. Fetch Headers (X, Y, Z) with parent hierarchy
    const headersRes = await conn.query(`
      SELECT hed.Direction, hdv.HeaderVID, hdv.Code, hdv.Label, tvh."Order",
             hed.HeaderID, tvh.ParentHeaderID, tvh.IsAbstract
      FROM 'TableVersion.parquet' tv
      JOIN 'TableVersionHeader.parquet' tvh ON tvh.TableVID = tv.TableVID
      JOIN 'HeaderVersion.parquet' hdv ON hdv.HeaderVID = tvh.HeaderVID 
          AND hdv.HeaderID = tvh.HeaderID
      JOIN 'Header.parquet' hed ON hed.HeaderID = tvh.HeaderID 
          AND hed.TableID = tv.TableID
      WHERE tv.TableVID = ${tableVid}
      ORDER BY hed.Direction, tvh."Order";
    `);
    const headers = headersRes.toArray().map(r => r.toJSON());

    // If table has 0 headers, check if child sub-tables exist (e.g., K_04.00 -> K_04.00.a, K_04.00.b)
    if (headers.length === 0) {
      const childrenRes = await conn.query(`
        SELECT tv.TableVID, tv.Code AS TableCode, 
               COALESCE(NULLIF(tv.Description, ''), NULLIF(tv.Name, ''), tv.Code) AS Description
        FROM 'ModuleVersionComposition.parquet' mvc
        JOIN 'TableVersion.parquet' tv ON tv.TableVID = mvc.TableVID
        WHERE mvc.ModuleVID = ${currentModuleVID}
          AND tv.Code LIKE '${code}.%'
        ORDER BY tv.Code;
      `);

      const children = childrenRes.toArray().map(r => r.toJSON());

      badgeRows.style.display = 'none';
      badgeCols.style.display = 'none';
      sheetTabsWrap.style.display = 'none';
      hideGridLoader();

      if (children.length > 0) {
        let linksHtml = children.map(c => `
          <button class="btn btn-secondary subtable-link-btn" data-vid="${c.TableVID}" data-code="${c.TableCode}" data-desc="${(c.Description || '').replace(/"/g, '&quot;')}">
            <strong>${c.TableCode}</strong> — ${c.Description || 'Sub-table layout'}
          </button>
        `).join('');

        tableContainer.innerHTML = `
          <div class="empty-table-card">
            <div class="etc-icon">📁</div>
            <div class="etc-title">Parent Container Table: ${code}</div>
            <div class="etc-desc">
              Table <strong>${code}</strong> ${desc ? '(' + desc + ')' : ''} is a parent container table.<br/>
              Select one of its concrete sub-tables below to view its layout and reported data:
            </div>
            <div class="etc-links">${linksHtml}</div>
          </div>
        `;

        tableContainer.querySelectorAll('.subtable-link-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const vid = parseInt(btn.getAttribute('data-vid'));
            const cCode = btn.getAttribute('data-code');
            const cDesc = btn.getAttribute('data-desc');
            currentTableVID = vid;
            renderTableList(currentTables);
            loadTableLayout(vid, cCode, cDesc);
          });
        });
      } else {
        tableContainer.innerHTML = `
          <div class="empty-table-card">
            <div class="etc-icon">ℹ️</div>
            <div class="etc-title">No Layout Defined for ${code}</div>
            <div class="etc-desc">This table entry does not contain header or cell definitions in this framework module.</div>
          </div>
        `;
      }
      return;
    }

    // 2. Fetch Cells with VariableID mapping for dp{VariableID}
    const cellsRes = await conn.query(`
      SELECT tvc.VariableVID, vv.VariableID, tvc.CellCode, 
             tvc.IsNullable, tvc.IsVoid, tvc.IsExcluded,
             cel.ColumnID, cel.RowID, cel.SheetID
      FROM 'TableVersionCell.parquet' tvc
      JOIN 'Cell.parquet' cel ON cel.CellID = tvc.CellID
      JOIN 'VariableVersion.parquet' vv ON vv.VariableVID = tvc.VariableVID
      WHERE tvc.TableVID = ${tableVid};
    `);
    const cells = cellsRes.toArray().map(r => r.toJSON());

    // Group headers by direction
    const xHeaders = headers.filter(h => h.Direction === 'X');
    const yHeaders = headers.filter(h => h.Direction === 'Y');
    const zHeaders = headers.filter(h => h.Direction === 'Z');

    // Handle Z Dimension (Sheets)
    if (zHeaders.length > 0) {
      sheetTabsWrap.style.display = 'flex';
      renderSheetTabs(zHeaders, tableVid, code, desc, headers, cells);
      if (!currentSheetHeaderID || !zHeaders.some(h => h.HeaderID === currentSheetHeaderID)) {
        currentSheetHeaderID = zHeaders[0].HeaderID;
      }
    } else {
      sheetTabsWrap.style.display = 'none';
      currentSheetHeaderID = null;
    }

    // Filter cells by selected Sheet if applicable
    const activeCells = currentSheetHeaderID 
      ? cells.filter(c => c.SheetID === currentSheetHeaderID)
      : cells;

    renderTableGrid(xHeaders, yHeaders, activeCells);

    badgeRows.style.display = 'inline-block';
    badgeCols.style.display = 'inline-block';
    badgeRows.textContent = `${yHeaders.filter(h => !h.IsAbstract).length} rows`;
    badgeCols.textContent = `${xHeaders.filter(h => !h.IsAbstract).length} cols`;

    hideGridLoader();

  } catch (err) {
    console.error('Error loading table layout:', err);
    hideGridLoader();
    tableContainer.innerHTML = `<div style="padding:20px; color:#ef4444;">Error loading table: ${err.message}</div>`;
  }
}

function renderSheetTabs(zHeaders, tableVid, code, desc, headers, cells) {
  sheetTabs.innerHTML = '';
  zHeaders.forEach(h => {
    const tab = document.createElement('div');
    tab.className = `sheet-tab ${h.HeaderID === currentSheetHeaderID ? 'active' : ''}`;
    tab.textContent = h.Label || h.Code;
    tab.addEventListener('click', () => {
      currentSheetHeaderID = h.HeaderID;
      document.querySelectorAll('.sheet-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const activeCells = cells.filter(c => c.SheetID === currentSheetHeaderID);
      const xHeaders = headers.filter(h => h.Direction === 'X');
      const yHeaders = headers.filter(h => h.Direction === 'Y');
      renderTableGrid(xHeaders, yHeaders, activeCells);
    });
    sheetTabs.appendChild(tab);
  });
}

function formatNumber(val) {
  if (val == null || val === '') return '';
  const numStr = String(val).trim();
  if (!isNaN(numStr) && !isNaN(parseFloat(numStr))) {
    const parts = numStr.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return parts.join('.');
  }
  return numStr;
}

function renderTableGrid(xHeaders, yHeaders, cells) {
  tableContainer.innerHTML = '';

  const table = document.createElement('table');
  table.className = 'dpm-table';

  // Build Cell Lookup Map: [RowID][ColumnID] -> Cell
  const cellMap = new Map();
  cells.forEach(c => {
    if (!cellMap.has(c.RowID)) cellMap.set(c.RowID, new Map());
    cellMap.get(c.RowID).set(c.ColumnID, c);
  });

  const xLeafs = xHeaders.filter(h => !h.IsAbstract);

  // Map header ID -> header object
  const xHeaderMap = new Map();
  xHeaders.forEach(h => xHeaderMap.set(h.HeaderID, h));

  // Map parent ID -> array of child headers
  const xChildrenMap = new Map();
  xHeaders.forEach(h => {
    if (h.ParentHeaderID) {
      if (!xChildrenMap.has(h.ParentHeaderID)) xChildrenMap.set(h.ParentHeaderID, []);
      xChildrenMap.get(h.ParentHeaderID).push(h);
    }
  });

  // Calculate depth level of each X header (0 = root)
  function getHeaderLevel(h) {
    let lvl = 0;
    let curr = h;
    while (curr && curr.ParentHeaderID && xHeaderMap.has(curr.ParentHeaderID)) {
      lvl++;
      curr = xHeaderMap.get(curr.ParentHeaderID);
    }
    return lvl;
  }

  const xLevelsMap = new Map();
  xHeaders.forEach(h => xLevelsMap.set(h.HeaderID, getHeaderLevel(h)));
  const maxLvl = Math.max(0, ...Array.from(xLevelsMap.values()));

  function isCellColumn(headerId) {
    return cells.some(c => c.ColumnID === headerId);
  }

  // For each X header, compute how many leaf columns it spans
  function getLeafSpanCount(h) {
    const children = xChildrenMap.get(h.HeaderID) || [];
    if (children.length === 0) return 1;

    let sum = 0;
    children.forEach(ch => {
      sum += getLeafSpanCount(ch);
    });
    // If h is also a cell column itself (not purely abstract), include 1 for h
    if (!h.IsAbstract && isCellColumn(h.HeaderID)) {
      sum += 1;
    }
    return Math.max(1, sum);
  }

  // -------------------------------------------------------------
  // THEAD: Column Headers
  // -------------------------------------------------------------
  const thead = document.createElement('thead');
  const headerRows = [];

  for (let l = 0; l <= maxLvl; l++) {
    const tr = document.createElement('tr');
    if (l === 0) {
      // 1. Dedicated Code Column Corner Header (sticky left:0)
      const thCornerCode = document.createElement('th');
      thCornerCode.className = 'corner-header corner-code';
      thCornerCode.rowSpan = maxLvl + 2;
      thCornerCode.textContent = 'Code';
      tr.appendChild(thCornerCode);

      // 2. Dedicated Row Label Column Corner Header (sticky left:65px)
      const thCornerLabel = document.createElement('th');
      thCornerLabel.className = 'corner-header corner-label';
      thCornerLabel.rowSpan = maxLvl + 2;
      thCornerLabel.textContent = 'Row Label';
      tr.appendChild(thCornerLabel);
    }
    headerRows.push(tr);
  }

  const rootXHeaders = xHeaders.filter(h => !h.ParentHeaderID || !xHeaderMap.has(h.ParentHeaderID));

  function renderXHeaderCell(h, level) {
    const th = document.createElement('th');
    th.textContent = h.Label || h.Code;

    const children = xChildrenMap.get(h.HeaderID) || [];
    const spanCount = getLeafSpanCount(h);
    if (spanCount > 1) {
      th.colSpan = spanCount;
    }

    if (children.length === 0 && level < maxLvl) {
      th.rowSpan = maxLvl - level + 1;
    }

    headerRows[level].appendChild(th);

    // If h is a parent AND also a cell column, render self-cell at level + 1
    if (children.length > 0 && !h.IsAbstract && isCellColumn(h.HeaderID)) {
      const selfTh = document.createElement('th');
      selfTh.textContent = h.Label || h.Code;
      if (level + 1 < maxLvl) {
        selfTh.rowSpan = maxLvl - level;
      }
      headerRows[level + 1].appendChild(selfTh);
    }

    // Recursively render children into lower levels
    children.forEach(ch => {
      renderXHeaderCell(ch, level + 1);
    });
  }

  rootXHeaders.forEach(h => renderXHeaderCell(h, 0));
  headerRows.forEach(tr => thead.appendChild(tr));

  // 3. Dedicated Column Code Row (bottommost row of THEAD)
  const trColCode = document.createElement('tr');
  trColCode.className = 'tr-col-codes';
  xLeafs.forEach(x => {
    const thCode = document.createElement('th');
    thCode.className = 'col-code-header';
    thCode.textContent = x.Code || '';
    trColCode.appendChild(thCode);
  });
  thead.appendChild(trColCode);

  table.appendChild(thead);

  // -------------------------------------------------------------
  // TBODY: Row Headers & Data Cells
  // -------------------------------------------------------------
  const tbody = document.createElement('tbody');

  const yParentMap = new Map();
  yHeaders.forEach(h => {
    if (h.ParentHeaderID) {
      if (!yParentMap.has(h.ParentHeaderID)) yParentMap.set(h.ParentHeaderID, []);
      yParentMap.get(h.ParentHeaderID).push(h.HeaderID);
    }
  });

  yHeaders.forEach(y => {
    const tr = document.createElement('tr');
    tr.setAttribute('data-header-id', y.HeaderID);
    if (y.ParentHeaderID) {
      tr.setAttribute('data-parent-id', y.ParentHeaderID);
    }

    const rowCells = cellMap.get(y.RowID) || cellMap.get(y.HeaderID);

    if (y.IsAbstract) {
      // Abstract Section Header Row
      tr.className = 'row-abstract';
      const thSec = document.createElement('th');
      thSec.className = 'section-header';
      thSec.colSpan = xLeafs.length + 2;

      const children = yParentMap.get(y.HeaderID) || [];
      if (children.length > 0) {
        const toggle = document.createElement('span');
        toggle.className = 'toggle-btn';
        toggle.textContent = '[−]';
        toggle.setAttribute('data-toggle-id', y.HeaderID);
        toggle.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleRowGroup(y.HeaderID);
        });
        thSec.appendChild(toggle);
      }

      const titleSpan = document.createElement('span');
      titleSpan.textContent = `${y.Code ? y.Code + ' ' : ''}${y.Label || ''}`;
      thSec.appendChild(titleSpan);
      tr.appendChild(thSec);

    } else {
      // Data Row: Column 1 (Code) + Column 2 (Label)
      const thCode = document.createElement('th');
      thCode.className = 'row-code-header';
      thCode.textContent = y.Code || '';
      tr.appendChild(thCode);

      const thRow = document.createElement('th');
      thRow.className = 'row-header';

      let indentClass = '';
      if (y.ParentHeaderID) {
        indentClass = 'indent-1';
      }
      if (indentClass) thRow.classList.add(indentClass);

      thRow.textContent = y.Label || y.Code;
      tr.appendChild(thRow);


      // Data Cells (one for each X leaf)
      xLeafs.forEach(x => {
        const td = document.createElement('td');
        td.className = 'cell-data';

        const cellInfo = rowCells ? rowCells.get(x.HeaderID) : null;

        if (cellInfo) {
          const dpId = `dp${cellInfo.VariableID}`;
          td.id = dpId;
          td.setAttribute('data-variable-vid', cellInfo.VariableVID);
          td.setAttribute('data-cell-code', cellInfo.CellCode || '');
          td.title = `${cellInfo.CellCode || ''} (${dpId})`;

          if (cellInfo.IsVoid) td.classList.add('cell-void');
          if (cellInfo.IsExcluded) td.classList.add('cell-excluded');

          // Populated data from report
          if (reportData.has(dpId)) {
            td.textContent = formatNumber(reportData.get(dpId));
            td.classList.add('cell-filled');
          }

          td.addEventListener('click', (e) => {
            document.querySelectorAll('.cell-data').forEach(c => c.classList.remove('selected'));
            td.classList.add('selected');
            inspectCell(cellInfo, y, x, td.textContent);
          });

        } else {
          td.classList.add('cell-void');
        }

        tr.appendChild(td);
      });
    }

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  tableContainer.appendChild(table);
}

function toggleRowGroup(parentHeaderId) {
  const childRows = document.querySelectorAll(`tr[data-parent-id="${parentHeaderId}"]`);
  const btn = document.querySelector(`.toggle-btn[data-toggle-id="${parentHeaderId}"]`);
  if (!childRows.length || !btn) return;

  const isCollapsed = childRows[0].style.display === 'none';
  childRows.forEach(row => {
    row.style.display = isCollapsed ? '' : 'none';
  });
  btn.textContent = isCollapsed ? '[−]' : '[+]';
}

function showGridLoader(text) {
  if (gridLoaderText) gridLoaderText.textContent = text || 'Loading...';
  if (gridLoader) gridLoader.style.display = 'flex';
}

function hideGridLoader() {
  if (gridLoader) gridLoader.style.display = 'none';
}

// -------------------------------------------------------------
// Cell Inspector
// -------------------------------------------------------------

async function inspectCell(cellInfo, rowHeader, colHeader, currentValue) {
  dpBody.innerHTML = '<div class="spinner" style="width:20px;height:20px;"></div> Fetching cell metadata…';
  const dpId = `dp${cellInfo.VariableID}`;

  try {
    // Query Metric and Context Details
    const res = await conn.query(`
      SELECT 
        vv.VariableVID, vv.VariableID,
        prp.PropertyID, itm.Name AS MetricName, itc.Code AS MetricCode,
        cat.Code AS CategoryCode, cat.Name AS CategoryName,
        citc.Code AS ItemCategoryCode, citm.Name AS ItemName
      FROM 'VariableVersion.parquet' vv
      LEFT JOIN 'Property.parquet' prp ON prp.PropertyID = vv.PropertyID
      LEFT JOIN 'ItemCategory.parquet' itc ON itc.ItemID = vv.PropertyID AND itc.EndReleaseID IS NULL
      LEFT JOIN 'Item.parquet' itm ON itm.ItemID = vv.PropertyID
      LEFT JOIN 'ContextComposition.parquet' coc ON coc.ContextID = vv.ContextID
      LEFT JOIN 'Item.parquet' citm ON citm.ItemID = coc.ItemID
      LEFT JOIN 'ItemCategory.parquet' citc ON citc.ItemID = citm.ItemID AND citc.EndReleaseID IS NULL
      LEFT JOIN 'Category.parquet' cat ON cat.CategoryID = citc.CategoryID
      WHERE vv.VariableVID = ${cellInfo.VariableVID};
    `);

    const rows = res.toArray().map(r => r.toJSON());
    const first = rows[0] || {};

    let html = `
      <div class="meta-grid">
        <div class="meta-item">
          <label>Datapoint ID</label>
          <span class="highlight">${dpId}</span>
        </div>
        <div class="meta-item">
          <label>VariableVID</label>
          <span>${cellInfo.VariableVID}</span>
        </div>
        <div class="meta-item">
          <label>Cell Code</label>
          <span>${cellInfo.CellCode || '—'}</span>
        </div>
        <div class="meta-item">
          <label>Reported Value</label>
          <span class="highlight">${currentValue || '(empty)'}</span>
        </div>
        <div class="meta-item">
          <label>Metric</label>
          <span>${first.MetricCode || ''} — ${first.MetricName || '—'}</span>
        </div>
        <div class="meta-item">
          <label>Row Position</label>
          <span>${rowHeader.Label || rowHeader.Code}</span>
        </div>
        <div class="meta-item">
          <label>Column Position</label>
          <span>${colHeader.Label || colHeader.Code}</span>
        </div>
      </div>
    `;

    if (rows.length > 0 && rows.some(r => r.CategoryCode)) {
      html += `
        <div style="margin-top:12px;">
          <label style="font-size:10px; text-transform:uppercase; color:var(--text-dim); font-weight:600;">Context Dimensions</label>
          <table class="dpm-table" style="width:100%; margin-top:4px;">
            <thead>
              <tr>
                <th style="text-align:left;">Category</th>
                <th style="text-align:left;">Member Item</th>
              </tr>
            </thead>
            <tbody>
      `;
      rows.forEach(r => {
        if (r.CategoryCode) {
          html += `
            <tr>
              <td style="font-weight:500;">${r.CategoryCode} (${r.CategoryName || ''})</td>
              <td><code>${r.ItemCategoryCode || ''}</code> ${r.ItemName || ''}</td>
            </tr>
          `;
        }
      });
      html += `</tbody></table></div>`;
    }

    dpBody.innerHTML = html;

  } catch (err) {
    console.error('Cell inspector query error:', err);
    dpBody.innerHTML = `<div style="color:#ef4444;">Error inspecting cell: ${err.message}</div>`;
  }
}

// -------------------------------------------------------------
// Report Data Loader (XBRL-CSV)
// -------------------------------------------------------------

function setupEventListeners() {
  releaseSelect.addEventListener('change', async (e) => {
    currentReleaseID = parseInt(e.target.value);
    await loadModules();
  });

  moduleSelect.addEventListener('change', async (e) => {
    currentModuleVID = parseInt(e.target.value);
    currentTableVID = null;
    await loadTableList();
  });

  tableList.setAttribute('tabindex', '0');

  tableSearch.addEventListener('input', () => {
    loadTableList();
  });

  tableSearch.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter') {
      e.preventDefault();
      tableList.focus();
      const activeOrFirst = tableList.querySelector('.table-item.active') || tableList.querySelector('.table-item');
      if (activeOrFirst) {
        activeOrFirst.click();
      }
    }
  });

  window.addEventListener('keydown', (e) => {
    const activeEl = document.activeElement;
    if (activeEl && ['INPUT', 'SELECT', 'TEXTAREA'].includes(activeEl.tagName)) {
      return;
    }
    if (infoModal.classList.contains('open')) return;

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const items = Array.from(tableList.querySelectorAll('.table-item'));
      if (items.length === 0) return;

      let currentIndex = items.findIndex(el => el.classList.contains('active'));
      let nextIndex = currentIndex;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        nextIndex = (currentIndex >= 0 && currentIndex < items.length - 1) ? currentIndex + 1 : 0;
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        nextIndex = currentIndex > 0 ? currentIndex - 1 : items.length - 1;
      }

      if (items[nextIndex]) {
        const nextItem = items[nextIndex];
        items.forEach(el => el.classList.remove('active'));
        nextItem.classList.add('active');
        nextItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        nextItem.click();
      }
    }
  });


  btnViewMode.addEventListener('click', () => {
    viewMode = viewMode === 'compact' ? 'detailed' : 'compact';
    tableList.className = `table-list ${viewMode}-view`;
    btnViewMode.classList.toggle('active', viewMode === 'detailed');
  });

  btnCloseDp.addEventListener('click', () => {
    detailPane.style.maxHeight = '0px';
    detailPane.style.display = 'none';
  });

  btnInfo.addEventListener('click', () => infoModal.classList.add('open'));
  btnCloseModal.addEventListener('click', () => infoModal.classList.remove('open'));
  btnModalOk.addEventListener('click', () => infoModal.classList.remove('open'));

  // Report Upload
  btnLoadReport.addEventListener('click', () => reportFileInput.click());
  reportFileInput.addEventListener('change', handleReportUpload);

  const btnSampleCodis = document.getElementById('btn-sample-codis');
  const btnSampleFindis = document.getElementById('btn-sample-findis');

  if (btnSampleCodis) {
    btnSampleCodis.addEventListener('click', () => {
      loadSampleReport('reports/codis/P4GTT6GF1W40CVIMFR43.CON_PL_PILLAR3020000_CODIS_2025-12-31_20260325144416216.zip', 'CODIS');
    });
  }
  if (btnSampleFindis) {
    btnSampleFindis.addEventListener('click', () => {
      loadSampleReport('reports/codis/P4GTT6GF1W40CVIMFR43.CON_PL_PILLAR3020000_FINDIS_2025-12-31_20260325150838169.zip', 'FINDIS');
    });
  }

  btnClearReport.addEventListener('click', () => {
    reportData.clear();
    reportedTablesSet.clear();
    reportMeta = null;
    reportFileInput.value = '';
    reportBanner.style.display = 'none';
    document.querySelectorAll('.cell-data').forEach(c => {
      c.textContent = '';
      c.classList.remove('cell-filled');
    });
    renderTableList(currentTables);
    showToast('Report cleared.');
  });
}

async function handleReportUpload(e) {
  const file = e.target.files[0];
  if (!file) return;

  if (file.name.toLowerCase().endsWith('.zip')) {
    await parseReportZip(file);
  } else if (file.name.toLowerCase().endsWith('.csv')) {
    const text = await file.text();
    parseSingleReportCSV(text, file.name);
  } else {
    showToast('Please select a .zip or .csv report file.');
  }
}

async function parseReportZip(file) {
  if (typeof JSZip === 'undefined') {
    showToast('JSZip library is not loaded. Cannot unzip file.');
    return;
  }

  showGridLoader('Extracting XBRL-CSV report package ZIP…');
  try {
    const zip = await JSZip.loadAsync(file);
    let matchedDatapoints = 0;
    let totalDatapoints = 0;
    let parsedFilesCount = 0;

    const paramsMap = new Map();

    // 1. First pass: FilingIndicators.csv and parameters.csv
    for (const relativePath of Object.keys(zip.files)) {
      const entry = zip.files[relativePath];
      if (entry.dir) continue;

      const baseName = relativePath.split('/').pop();
      if (baseName.toLowerCase() === 'filingindicators.csv') {
        const text = await entry.async('string');
        const lines = text.trim().split('\n');
        for (let i = 1; i < lines.length; i++) {
          const [tplId, reported] = lines[i].split(',').map(s => s.trim());
          if (tplId && (reported === 'true' || reported === '1')) {
            reportedTablesSet.add(tplId);
          }
        }
      } else if (baseName.toLowerCase() === 'parameters.csv') {
        const text = await entry.async('string');
        const lines = text.trim().split('\n');
        for (let i = 1; i < lines.length; i++) {
          const [key, val] = lines[i].split(',').map(s => s.trim());
          if (key && val) paramsMap.set(key, val);
        }
      }
    }

    // 2. Second pass: data CSVs (k_*.csv)
    for (const relativePath of Object.keys(zip.files)) {
      const entry = zip.files[relativePath];
      if (entry.dir) continue;

      const baseName = relativePath.split('/').pop().toLowerCase();
      if (baseName.endsWith('.csv') && baseName !== 'filingindicators.csv' && baseName !== 'parameters.csv') {
        parsedFilesCount++;
        const codeMatch = baseName.replace(/\.csv$/, '').toUpperCase();
        reportedTablesSet.add(codeMatch);

        const text = await entry.async('string');
        const lines = text.trim().split('\n');
        for (let i = 1; i < lines.length; i++) {
          const parts = lines[i].split(',');
          if (parts.length >= 2) {
            const dpId = parts[0].trim();
            const val = parts[1].trim();
            if (dpId) {
              reportData.set(dpId, val);
              totalDatapoints++;
              const cell = document.getElementById(dpId);
              if (cell) {
                cell.textContent = formatNumber(val);
                cell.classList.add('cell-filled');
                matchedDatapoints++;
              }
            }
          }
        }
      }
    }

    hideGridLoader();

    // 3. Build status metadata
    let metaStr = `Archive: ${file.name} | ${parsedFilesCount} CSV tables | ${totalDatapoints.toLocaleString()} datapoints`;
    if (paramsMap.has('entityID')) metaStr += ` | Entity: ${paramsMap.get('entityID').replace(/^rs:/, '')}`;
    if (paramsMap.has('refPeriod')) metaStr += ` | RefPeriod: ${paramsMap.get('refPeriod')}`;
    if (paramsMap.has('baseCurrency')) metaStr += ` | Currency: ${paramsMap.get('baseCurrency').replace(/^iso4217:/, '')}`;

    reportBanner.style.display = 'flex';
    reportBannerMeta.textContent = metaStr;

    // Refresh sidebar table list to display reported badges
    renderTableList(currentTables);

    // Refresh currently loaded table if visible
    if (currentTableVID) {
      document.querySelectorAll('.cell-data').forEach(td => {
        if (td.id && reportData.has(td.id)) {
          td.textContent = formatNumber(reportData.get(td.id));
          td.classList.add('cell-filled');
        }
      });
    }

    showToast(`Loaded ${parsedFilesCount} tables (${totalDatapoints.toLocaleString()} datapoints) from ZIP package!`);

  } catch (err) {
    hideGridLoader();
    console.error('Error parsing ZIP file:', err);
    showToast(`Error unzipping report: ${err.message}`);
  }
}

function parseSingleReportCSV(csvText, filename) {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return;

  let matched = 0;
  let unmatched = 0;

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length >= 2) {
      const dpId = parts[0].trim();
      const val = parts[1].trim();

      reportData.set(dpId, val);

      const cell = document.getElementById(dpId);
      if (cell) {
        cell.textContent = formatNumber(val);
        cell.classList.add('cell-filled');
        matched++;
      } else {
        unmatched++;
      }
    }
  }

  reportBanner.style.display = 'flex';
  reportBannerMeta.textContent = `File: ${filename} | Loaded ${matched + unmatched} datapoints`;
  showToast(`Loaded ${matched} matching datapoints (${unmatched} in other tables).`);
}

async function loadSampleReport(url, targetModuleCode) {
  showGridLoader(`Fetching sample ${targetModuleCode} report package…`);
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const blob = await response.blob();
    const filename = url.split('/').pop();
    const file = new File([blob], filename, { type: 'application/zip' });

    if (targetModuleCode) {
      const opts = Array.from(moduleSelect.options);
      const targetOpt = opts.find(o => o.textContent.includes(targetModuleCode));
      if (targetOpt && parseInt(targetOpt.value) !== currentModuleVID) {
        currentModuleVID = parseInt(targetOpt.value);
        moduleSelect.value = currentModuleVID;
        currentTableVID = null;
        await loadTableList();
      }
    }

    await parseReportZip(file);
  } catch (err) {
    hideGridLoader();
    console.error('Failed to load sample report:', err);
    showToast(`Failed to load sample report: ${err.message}`);
  }
}

// Start Application
init();

