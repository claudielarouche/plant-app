'use strict';

// ============================================================
// UTILS
// ============================================================
const uuid = () => ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
  (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));

const today = () => new Date().toISOString().slice(0, 10);

const formatDate = (d) => {
  if (!d) return '';
  const dt = new Date(d + 'T00:00:00');
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

const daysSince = (dateStr) => {
  if (!dateStr) return null;
  const ms = Date.now() - new Date(dateStr + 'T00:00:00').getTime();
  return Math.floor(ms / 86400000);
};

const esc = (s) => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ============================================================
// DB (localStorage)
// ============================================================
const DB = {
  KEY_PLANTS: 'gj_plants',
  KEY_LOGS: 'gj_logs',
  KEY_SETTINGS: 'gj_settings',

  getPlants() { try { return JSON.parse(localStorage.getItem(this.KEY_PLANTS) || '[]'); } catch { return []; } },
  getLogs() { try { return JSON.parse(localStorage.getItem(this.KEY_LOGS) || '[]'); } catch { return []; } },
  getSettings() { try { return JSON.parse(localStorage.getItem(this.KEY_SETTINGS) || '{}'); } catch { return {}; } },

  savePlants(p) { localStorage.setItem(this.KEY_PLANTS, JSON.stringify(p)); },
  saveLogs(l) { localStorage.setItem(this.KEY_LOGS, JSON.stringify(l)); },
  saveSettings(s) { localStorage.setItem(this.KEY_SETTINGS, JSON.stringify(s)); },

  addPlant(p) { const a = this.getPlants(); a.push(p); this.savePlants(a); },
  updatePlant(p) { const a = this.getPlants().map(x => x.id === p.id ? p : x); this.savePlants(a); },
  deletePlant(id) { this.savePlants(this.getPlants().filter(x => x.id !== id)); this.saveLogs(this.getLogs().filter(x => x.plantId !== id)); },

  addLog(l) { const a = this.getLogs(); a.push(l); this.saveLogs(a); },
  updateLog(l) { const a = this.getLogs().map(x => x.id === l.id ? l : x); this.saveLogs(a); },
  deleteLog(id) { this.saveLogs(this.getLogs().filter(x => x.id !== id)); },

  getPlantLogs(plantId) { return this.getLogs().filter(x => x.plantId === plantId).sort((a,b) => a.date.localeCompare(b.date)); },
  getLastAction(plantId) {
    const logs = this.getLogs().filter(x => x.plantId === plantId).sort((a,b) => b.date.localeCompare(a.date));
    return logs.length ? logs[0] : null;
  },

  exportAll() { return { plants: this.getPlants(), logs: this.getLogs(), settings: this.getSettings(), exportedAt: new Date().toISOString(), version: 1 }; },
  importAll(data) {
    if (!data.plants || !data.logs) throw new Error('Invalid format');
    const existing = this.exportAll();
    const plantMap = Object.fromEntries(existing.plants.map(p => [p.id, p]));
    const logMap = Object.fromEntries(existing.logs.map(l => [l.id, l]));
    data.plants.forEach(p => plantMap[p.id] = p);
    data.logs.forEach(l => logMap[l.id] = l);
    this.savePlants(Object.values(plantMap));
    this.saveLogs(Object.values(logMap));
  }
};

// ============================================================
// SYNC (Netlify Blobs via serverless function)
// ============================================================
const Sync = {
  endpoint: '/.netlify/functions/sync',

  getGardenId() { return DB.getSettings().gardenId || null; },

  async push() {
    const id = this.getGardenId();
    if (!id) return;
    setSyncDot('syncing');
    try {
      const res = await fetch(`${this.endpoint}?id=${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(DB.exportAll())
      });
      if (!res.ok) throw new Error('Push failed');
      setSyncDot('ok');
      const s = DB.getSettings(); s.lastSync = new Date().toISOString(); DB.saveSettings(s);
      updateSyncDesc();
    } catch (e) {
      setSyncDot('error');
      console.warn('Sync push failed:', e);
    }
  },

  async pull() {
    const id = this.getGardenId();
    if (!id) return false;
    setSyncDot('syncing');
    try {
      const res = await fetch(`${this.endpoint}?id=${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error('Pull failed');
      const data = await res.json();
      if (data && data.plants) {
        DB.importAll(data);
        setSyncDot('ok');
        return true;
      }
      setSyncDot('ok');
      return false;
    } catch (e) {
      setSyncDot('error');
      console.warn('Sync pull failed:', e);
      return false;
    }
  },

  async syncIfNeeded() {
    const id = this.getGardenId();
    if (!id) return;
    const pulled = await this.pull();
    if (pulled) renderDashboard();
  }
};

// ============================================================
// STATE
// ============================================================
let state = {
  view: 'dashboard',
  currentPlantId: null,
  searchQuery: '',
  filterAction: 'all',
  filterPlant: 'all'
};

// ============================================================
// NAVIGATION
// ============================================================
function navigate(view) {
  const views = ['dashboard', 'search', 'export', 'settings'];
  if (!views.includes(view)) return;

  state.view = view;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view' + capitalize(view)).classList.add('active');

  document.querySelectorAll('.nav-btn[data-nav]').forEach(b => {
    b.classList.toggle('active', b.dataset.nav === view);
  });

  document.getElementById('backBtn').style.display = 'none';
  document.getElementById('detailFab').style.display = 'none';
  document.getElementById('searchNavBtn').style.display = view === 'dashboard' ? 'flex' : 'none';
  document.getElementById('headerTitle').innerHTML = {
    dashboard: '🌿 Garden Journal <span style="font-size:11px;font-weight:700;background:var(--g7);color:var(--g3);padding:2px 7px;border-radius:20px;vertical-align:middle">v1.7</span>',
    search: 'Search',
    export: 'Export / Import',
    settings: 'Settings'
  }[view];

  if (view === 'search') {
    setTimeout(() => document.getElementById('searchInput').focus(), 100);
    renderSearch();
  }
  if (view === 'dashboard') renderDashboard();
}

function showDetail(plantId) {
  state.currentPlantId = plantId;
  state.view = 'detail';

  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('viewDetail').classList.add('active');
  document.querySelectorAll('.nav-btn[data-nav]').forEach(b => b.classList.remove('active'));

  document.getElementById('backBtn').style.display = 'flex';
  document.getElementById('detailFab').style.display = 'flex';
  document.getElementById('searchNavBtn').style.display = 'none';

  const plant = DB.getPlants().find(p => p.id === plantId);
  document.getElementById('headerTitle').textContent = plant ? plant.name : 'Plant';

  renderDetail(plantId);
}

function goBack() {
  if (state.view === 'detail') navigate('dashboard');
  else navigate('dashboard');
}

document.getElementById('backBtn').addEventListener('click', goBack);
document.getElementById('searchNavBtn').addEventListener('click', () => navigate('search'));

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ============================================================
// RENDER: DASHBOARD
// ============================================================
function renderDashboard() {
  const plants = DB.getPlants().filter(p => p.active !== false);
  const grid = document.getElementById('plantsGrid');
  const count = document.getElementById('plantCount');
  count.textContent = plants.length ? `${plants.length} plant${plants.length !== 1 ? 's' : ''}` : '';

  if (!plants.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <div class="empty-icon">🌱</div>
      <div class="empty-title">No plants yet</div>
      <div class="empty-desc">Tap the <strong>+</strong> button below to add your first plant and start tracking its care.</div>
    </div>`;
    return;
  }

  grid.innerHTML = plants.map(plant => {
    const lastAction = DB.getLastAction(plant.id);
    const daysSinceAny = lastAction ? daysSince(lastAction.date) : null;

    let activityBadge = '';
    if (daysSinceAny !== null) {
      activityBadge = `<span class="badge badge-earth">${actionEmoji(lastAction.action)} ${daysSinceAny === 0 ? 'Today' : daysSinceAny + 'd ago'}</span>`;
    }

    return `<div class="plant-card" onclick="showDetail('${esc(plant.id)}')">
      <div class="plant-card-header">
        <div class="plant-icon">${esc(plant.emoji || '🌱')}</div>
        <div class="plant-card-info">
          <div class="plant-name">${esc(plant.name)}</div>
          ${plant.type ? `<div class="plant-type">${esc(plant.type)}</div>` : ''}
          ${plant.location ? `<div class="plant-location"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>${esc(plant.location)}</div>` : ''}
        </div>
      </div>
      <div class="plant-card-meta">
        ${activityBadge}
      </div>
      <div class="plant-card-actions" onclick="event.stopPropagation()">
        <button class="quick-btn quick-btn-note" onclick="openAddLog('${esc(plant.id)}')">📝 Note</button>
      </div>
    </div>`;
  }).join('');
}

// ============================================================
// RENDER: PLANT DETAIL
// ============================================================
function renderDetail(plantId) {
  const plant = DB.getPlants().find(p => p.id === plantId);
  if (!plant) { navigate('dashboard'); return; }

  const logs = DB.getPlantLogs(plantId);

  const groups = {};
  logs.forEach(log => {
    const key = log.date.slice(0, 7);
    if (!groups[key]) groups[key] = [];
    groups[key].push(log);
  });

  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  const timelineHTML = Object.entries(groups).reverse().map(([month, entries]) => {
    const [y, m] = month.split('-');
    const label = `${monthNames[parseInt(m)-1]} ${y}`;
    const entriesHTML = [...entries].reverse().map(log => {
      const actionClass = `action-${log.action}`;
      return `<div class="timeline-entry">
        <div class="entry-dot ${actionClass}">${actionEmoji(log.action)}</div>
        <div class="entry-content">
          <div class="entry-action">${capitalize(log.action)}</div>
          <div class="entry-date">${formatDate(log.date)}</div>
          ${log.notes ? `<div class="entry-notes">${esc(log.notes)}</div>` : ''}
          ${log.photo ? `<img class="entry-photo" src="${log.photo}" loading="lazy" alt="log photo" onclick="openLogPhoto('${encodeURIComponent(log.photo)}','${log.date || ''}','${plant.startDate || ''}')">` : ''}
          <div class="entry-actions">
            <button class="entry-action-btn" onclick="editLog('${esc(log.id)}')">Edit</button>
            <button class="entry-action-btn" style="color:var(--red)" onclick="confirmDeleteLog('${esc(log.id)}')">Delete</button>
          </div>
        </div>
      </div>`;
    }).join('');
    return `<div class="timeline-month">${label}</div>${entriesHTML}`;
  }).join('');

  const photosHTML = (plant.photos || []).map((ph, i) =>
    `<img class="photo-thumb" src="${ph.data}" loading="lazy" alt="plant photo ${i+1}" onclick="openPlantPhoto('${esc(plant.id)}',${i})">`
  ).join('') + `<div class="add-photo-thumb" onclick="addPlantPhoto('${esc(plant.id)}')">
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>
  </div>`;

  document.getElementById('detailContent').innerHTML = `
    <div class="plant-detail-header">
      <div style="display:flex;align-items:center;gap:14px">
        <div class="plant-icon" style="width:56px;height:56px;font-size:28px">${esc(plant.emoji || '🌱')}</div>
        <div style="flex:1;min-width:0">
          <div class="plant-detail-name">${esc(plant.name)}</div>
          ${plant.type ? `<div class="plant-type" style="font-size:13px;color:var(--text3)">${esc(plant.type)}</div>` : ''}
        </div>
      </div>
      <div class="plant-detail-meta">
        ${plant.location ? `<div class="meta-row"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>${esc(plant.location)}</div>` : ''}
        ${plant.startDate ? `<div class="meta-row"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>Started ${formatDate(plant.startDate)}</div>` : ''}
        ${plant.notes ? `<div class="meta-row" style="align-items:flex-start"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="margin-top:2px"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><span style="white-space:pre-wrap">${esc(plant.notes)}</span></div>` : ''}
      </div>
      ${(plant.photos && plant.photos.length) || true ? `<div class="plant-photos">${photosHTML}</div>` : ''}
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn btn-secondary btn-sm" onclick="openEditPlant('${esc(plant.id)}')">✏️ Edit plant</button>
        <button class="btn btn-danger btn-sm" onclick="confirmDeletePlant('${esc(plant.id)}')">🗑️ Delete</button>
      </div>
    </div>

    ${logs.length ? `
    <div class="section-title">
      <span>Care Log</span>
      <span class="plant-count">${logs.length} entr${logs.length !== 1 ? 'ies' : 'y'}</span>
    </div>
    <div class="timeline">${timelineHTML}</div>
    ` : `
    <div class="empty-state">
      <div class="empty-icon">📋</div>
      <div class="empty-title">No log entries yet</div>
      <div class="empty-desc">Tap the + button to record your first care action for this plant.</div>
    </div>`}

    <input type="file" id="plantPhotoInput_${esc(plant.id)}" accept="image/*" capture="environment" style="display:none" onchange="handlePlantPhoto(this, '${esc(plant.id)}')">
  `;
}

// ============================================================
// RENDER: SEARCH
// ============================================================
function renderSearch() {
  const chips = document.getElementById('filterChips');
  const actions = ['all','fertilized','pruned','repotted','treated','observed','harvested'];
  chips.innerHTML = actions.map(a => `
    <button class="chip ${state.filterAction === a ? 'active' : ''}" onclick="setFilterAction('${a}')">
      ${a === 'all' ? 'All actions' : actionEmoji(a) + ' ' + capitalize(a)}
    </button>
  `).join('');
  doSearch();
}

function setFilterAction(action) {
  state.filterAction = action;
  renderSearch();
}

function doSearch() {
  const q = (document.getElementById('searchInput').value || '').toLowerCase().trim();
  state.searchQuery = q;
  const plants = DB.getPlants();
  const logs = DB.getLogs();
  const results = document.getElementById('searchResults');

  if (!q && state.filterAction === 'all') {
    results.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-title">Search your garden</div><div class="empty-desc">Type to search plants and log entries, or filter by action type.</div></div>`;
    return;
  }

  let filteredLogs = logs;
  if (state.filterAction !== 'all') filteredLogs = filteredLogs.filter(l => l.action === state.filterAction);
  if (q) filteredLogs = filteredLogs.filter(l => {
    const plant = plants.find(p => p.id === l.plantId);
    return (l.notes || '').toLowerCase().includes(q) ||
      (plant && plant.name.toLowerCase().includes(q)) ||
      l.action.includes(q);
  });

  let filteredPlants = plants;
  if (q) filteredPlants = filteredPlants.filter(p =>
    p.name.toLowerCase().includes(q) ||
    (p.type || '').toLowerCase().includes(q) ||
    (p.location || '').toLowerCase().includes(q) ||
    (p.notes || '').toLowerCase().includes(q)
  );
  if (state.filterAction !== 'all') filteredPlants = [];

  const plantMap = Object.fromEntries(plants.map(p => [p.id, p]));

  if (!filteredLogs.length && !filteredPlants.length) {
    results.innerHTML = `<div class="empty-state"><div class="empty-icon">😔</div><div class="empty-title">No results</div><div class="empty-desc">Try different search terms or filters.</div></div>`;
    return;
  }

  const plantsHTML = filteredPlants.map(p => `
    <div class="plant-card" onclick="showDetail('${esc(p.id)}')">
      <div class="plant-card-header">
        <div class="plant-icon">${esc(p.emoji || '🌱')}</div>
        <div class="plant-card-info">
          <div class="plant-name">${esc(p.name)}</div>
          ${p.type ? `<div class="plant-type">${esc(p.type)}</div>` : ''}
          ${p.location ? `<div class="plant-location">${esc(p.location)}</div>` : ''}
        </div>
      </div>
    </div>
  `).join('');

  const logsHTML = filteredLogs.sort((a,b) => b.date.localeCompare(a.date)).map(log => {
    const plant = plantMap[log.plantId];
    if (!plant) return '';
    return `<div class="timeline-entry" onclick="showDetail('${esc(plant.id)}')" style="cursor:pointer;background:var(--card);border-radius:var(--r);padding:14px;border:1px solid var(--border);box-shadow:var(--shadow);margin-bottom:8px">
      <div class="entry-dot action-${log.action}">${actionEmoji(log.action)}</div>
      <div class="entry-content">
        <div class="entry-action">${esc(plant.emoji || '🌱')} ${esc(plant.name)}</div>
        <div class="entry-date">${capitalize(log.action)} · ${formatDate(log.date)}</div>
        ${log.notes ? `<div class="entry-notes">${esc(log.notes)}</div>` : ''}
      </div>
    </div>`;
  }).join('');

  results.innerHTML = `
    ${filteredPlants.length ? `<div class="section-title"><span>Plants (${filteredPlants.length})</span></div><div class="cards-grid" style="margin-bottom:16px">${plantsHTML}</div>` : ''}
    ${filteredLogs.length ? `<div class="section-title"><span>Log Entries (${filteredLogs.length})</span></div>${logsHTML}` : ''}
  `;
}

document.getElementById('searchInput').addEventListener('input', debounce(doSearch, 200));

// ============================================================
// PLANT CRUD
// ============================================================
function openAddPlant() {
  document.getElementById('plantId').value = '';
  document.getElementById('plantName').value = '';
  document.getElementById('plantType').value = '';
  document.getElementById('plantStart').value = today();
  document.getElementById('plantLocation').value = '';
  document.getElementById('plantEmoji').value = '🌱';
  document.getElementById('plantNotes').value = '';
  document.getElementById('modalPlantTitle').textContent = 'Add Plant';
  openModal('modalPlant');
  setTimeout(() => document.getElementById('plantName').focus(), 100);
}

function openEditPlant(id) {
  const p = DB.getPlants().find(x => x.id === id);
  if (!p) return;
  document.getElementById('plantId').value = p.id;
  document.getElementById('plantName').value = p.name || '';
  document.getElementById('plantType').value = p.type || '';
  document.getElementById('plantStart').value = p.startDate || '';
  document.getElementById('plantLocation').value = p.location || '';
  document.getElementById('plantEmoji').value = p.emoji || '🌱';
  document.getElementById('plantNotes').value = p.notes || '';
  document.getElementById('modalPlantTitle').textContent = 'Edit Plant';
  openModal('modalPlant');
}

function savePlant() {
  const name = document.getElementById('plantName').value.trim();
  if (!name) { showToast('Plant name is required'); document.getElementById('plantName').focus(); return; }

  const id = document.getElementById('plantId').value || uuid();
  const existing = DB.getPlants().find(p => p.id === id);

  const plant = {
    ...(existing || {}),
    id,
    name,
    type: document.getElementById('plantType').value,
    startDate: document.getElementById('plantStart').value,
    location: document.getElementById('plantLocation').value.trim(),
    emoji: document.getElementById('plantEmoji').value,
    notes: document.getElementById('plantNotes').value.trim(),
    active: true,
    updatedAt: new Date().toISOString()
  };

  if (existing) {
    DB.updatePlant(plant);
    showToast('Plant updated');
  } else {
    plant.createdAt = new Date().toISOString();
    plant.photos = [];
    DB.addPlant(plant);
    showToast('Plant added 🌱');
  }

  closeModal('modalPlant');
  if (state.view === 'dashboard') renderDashboard();
  else if (state.view === 'detail') renderDetail(plant.id);
  schedulePush();
}

function confirmDeletePlant(id) {
  const p = DB.getPlants().find(x => x.id === id);
  if (!p) return;
  if (confirm(`Delete "${p.name}"? This will also delete all ${DB.getPlantLogs(id).length} log entries.`)) {
    DB.deletePlant(id);
    showToast('Plant deleted');
    navigate('dashboard');
    schedulePush();
  }
}

// ============================================================
// PLANT PHOTOS
// ============================================================
function addPlantPhoto(plantId) {
  const input = document.getElementById(`plantPhotoInput_${plantId}`);
  if (input) input.click();
}

function handlePlantPhoto(input, plantId) {
  const file = input.files[0];
  if (!file) return;
  compressImage(file, 1200, 0.82, (dataUrl) => {
    const plant = DB.getPlants().find(p => p.id === plantId);
    if (!plant) return;
    plant.photos = plant.photos || [];
    plant.photos.push({ date: today(), data: dataUrl });
    DB.updatePlant(plant);
    renderDetail(plantId);
    schedulePush();
  });
}

// ============================================================
// LOG CRUD
// ============================================================
function openAddLog(plantId) {
  const id = plantId || state.currentPlantId;
  document.getElementById('logId').value = '';
  document.getElementById('logPlantId').value = id || '';
  document.getElementById('logDate').value = today();
  document.getElementById('logNotes').value = '';
  clearLogPhoto();

  const selectWrap = document.getElementById('logPlantSelectWrap');
  if (!id) {
    selectWrap.style.display = 'block';
    const select = document.getElementById('logPlantSelect');
    const plants = DB.getPlants().filter(p => p.active !== false);
    select.innerHTML = plants.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  } else {
    selectWrap.style.display = 'none';
  }

  document.querySelectorAll('#actionGrid .action-option').forEach(el => el.classList.remove('selected'));
  document.querySelector('#actionGrid .action-option[data-action="observed"]').classList.add('selected');

  document.getElementById('modalLogTitle').textContent = 'Log Entry';
  openModal('modalLog');
}

function editLog(logId) {
  const log = DB.getLogs().find(l => l.id === logId);
  if (!log) return;
  document.getElementById('logId').value = log.id;
  document.getElementById('logPlantId').value = log.plantId;
  document.getElementById('logDate').value = log.date;
  document.getElementById('logNotes').value = log.notes || '';
  document.getElementById('logPlantSelectWrap').style.display = 'none';

  document.querySelectorAll('#actionGrid .action-option').forEach(el => {
    el.classList.toggle('selected', el.dataset.action === log.action);
  });

  if (log.photo) {
    document.getElementById('logPhotoPreview').src = log.photo;
    document.getElementById('logPhotoPreview').style.display = 'block';
    document.getElementById('removePhotoBtn').style.display = 'inline-flex';
  } else {
    clearLogPhoto();
  }

  document.getElementById('modalLogTitle').textContent = 'Edit Entry';
  openModal('modalLog');
}

function saveLog() {
  const id = document.getElementById('logId').value || uuid();
  const plantId = document.getElementById('logPlantId').value ||
    document.getElementById('logPlantSelect').value;
  if (!plantId) { showToast('Select a plant'); return; }

  const selectedAction = document.querySelector('#actionGrid .action-option.selected');
  const action = selectedAction ? selectedAction.dataset.action : 'observed';
  const date = document.getElementById('logDate').value || today();

  const notes = document.getElementById('logNotes').value.trim();
  const photo = document.getElementById('logPhotoPreview').style.display !== 'none'
    ? document.getElementById('logPhotoPreview').src
    : null;

  const existing = DB.getLogs().find(l => l.id === id);
  const log = {
    ...(existing || {}),
    id,
    plantId,
    action,
    date,
    notes,
    photo: photo || null,
    updatedAt: new Date().toISOString()
  };

  if (existing) {
    DB.updateLog(log);
    showToast('Entry updated');
  } else {
    log.createdAt = new Date().toISOString();
    DB.addLog(log);
    showToast(`${actionEmoji(action)} ${capitalize(action)} logged`);
  }

  closeModal('modalLog');
  if (state.view === 'detail') renderDetail(plantId);
  else if (state.view === 'dashboard') renderDashboard();
  schedulePush();
}

function confirmDeleteLog(logId) {
  if (confirm('Delete this log entry?')) {
    const log = DB.getLogs().find(l => l.id === logId);
    DB.deleteLog(logId);
    showToast('Entry deleted');
    if (state.view === 'detail' && log) renderDetail(log.plantId);
    schedulePush();
  }
}

function selectAction(el) {
  document.querySelectorAll('#actionGrid .action-option').forEach(x => x.classList.remove('selected'));
  el.classList.add('selected');
}

// ============================================================
// LOG PHOTO
// ============================================================
function handleLogPhoto(input) {
  const file = input.files[0];
  if (!file) return;
  compressImage(file, 1200, 0.82, (dataUrl) => {
    document.getElementById('logPhotoPreview').src = dataUrl;
    document.getElementById('logPhotoPreview').style.display = 'block';
    document.getElementById('removePhotoBtn').style.display = 'inline-flex';
  });
}

function removeLogPhoto() {
  clearLogPhoto();
}

function clearLogPhoto() {
  const preview = document.getElementById('logPhotoPreview');
  preview.src = '';
  preview.style.display = 'none';
  document.getElementById('removePhotoBtn').style.display = 'none';
  document.getElementById('logPhotoInput').value = '';
}

// ============================================================
// IMAGE COMPRESSION
// ============================================================
function compressImage(file, maxDim, quality, callback) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      let w = img.width, h = img.height;
      if (w > maxDim || h > maxDim) {
        if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
        else { w = Math.round(w * maxDim / h); h = maxDim; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      callback(canvas.toDataURL('image/jpeg', quality));
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

// ============================================================
// PHOTO VIEWER
// ============================================================
let _photoCtx = { photos: [], index: 0, plantStartDate: null };

function openPlantPhoto(plantId, index) {
  const plant = DB.getPlants().find(p => p.id === plantId);
  if (!plant) return;
  _photoCtx = {
    photos: (plant.photos || []).map(ph => ({ src: ph.data, date: ph.date || null })),
    index,
    plantStartDate: plant.startDate || null
  };
  _showPhotoViewer();
}

function openLogPhoto(encodedSrc, photoDate, plantStartDate) {
  _photoCtx = {
    photos: [{ src: decodeURIComponent(encodedSrc), date: photoDate || null }],
    index: 0,
    plantStartDate: plantStartDate || null
  };
  _showPhotoViewer();
}

function _showPhotoViewer() {
  _renderPhotoFrame();
  document.getElementById('photoViewer').classList.add('open');
}

function _renderPhotoFrame() {
  const { photos, index, plantStartDate } = _photoCtx;
  const photo = photos[index];
  if (!photo) return;

  document.getElementById('photoViewerImg').src = photo.src;

  // Age / date info
  const ageEl = document.getElementById('photoViewerAge');
  const age = _plantAgeText(photo.date, plantStartDate);
  ageEl.textContent = age;
  ageEl.style.display = age ? '' : 'none';

  // Counter
  const counterEl = document.getElementById('photoViewerCounter');
  if (photos.length > 1) {
    counterEl.textContent = `${index + 1} / ${photos.length}`;
    counterEl.style.display = '';
  } else {
    counterEl.textContent = '';
    counterEl.style.display = 'none';
  }

  // Arrows
  const multi = photos.length > 1;
  document.getElementById('photoViewerPrev').classList.toggle('visible', multi);
  document.getElementById('photoViewerNext').classList.toggle('visible', multi);

  // Info bar visibility
  document.getElementById('photoViewerInfo').style.display = (age || photos.length > 1) ? '' : 'none';
}

function photoViewerNav(dir) {
  const len = _photoCtx.photos.length;
  _photoCtx.index = (_photoCtx.index + dir + len) % len;
  _renderPhotoFrame();
}

function closePhotoViewer() {
  document.getElementById('photoViewer').classList.remove('open');
  document.getElementById('photoViewerImg').src = '';
}

function _plantAgeText(photoDate, plantStartDate) {
  if (photoDate && plantStartDate) {
    const start = new Date(plantStartDate + 'T00:00:00');
    const taken = new Date(photoDate + 'T00:00:00');
    const days = Math.floor((taken - start) / 86400000);
    let age;
    if (days < 0)        age = null;
    else if (days === 0) age = 'Day 1';
    else if (days < 7)   age = `${days}d old`;
    else if (days < 30)  { const w = Math.floor(days/7), d = days%7; age = d ? `${w}w ${d}d old` : `${w} week${w!==1?'s':''} old`; }
    else if (days < 365) { const m = Math.floor(days/30), w = Math.floor((days%30)/7); age = w ? `${m}mo ${w}w old` : `${m} month${m!==1?'s':''} old`; }
    else                 { const y = Math.floor(days/365), m = Math.floor((days%365)/30); age = m ? `${y}y ${m}mo old` : `${y} year${y!==1?'s':''} old`; }
    if (age) return `${age} · ${formatDate(photoDate)}`;
  }
  if (photoDate && !plantStartDate) return formatDate(photoDate);
  if (!photoDate && plantStartDate) return 'Photo date unknown';
  return '';
}

// ============================================================
// EXPORT / IMPORT
// ============================================================
function exportJSON() {
  const data = DB.exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `garden-journal-${today()}.json`);
  showToast('JSON exported');
}

function exportCSV() {
  const plants = DB.getPlants();
  const logs = DB.getLogs();
  const plantMap = Object.fromEntries(plants.map(p => [p.id, p]));

  const rows = [['Date','Plant','Type','Location','Action','Notes']];
  logs.sort((a,b) => a.date.localeCompare(b.date)).forEach(log => {
    const p = plantMap[log.plantId] || {};
    rows.push([
      log.date,
      csvEsc(p.name || ''),
      csvEsc(p.type || ''),
      csvEsc(p.location || ''),
      log.action,
      csvEsc(log.notes || '')
    ]);
  });

  const csv = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  downloadBlob(blob, `garden-log-${today()}.csv`);
  showToast('CSV exported');
}

function csvEsc(s) { return `"${String(s).replace(/"/g, '""')}"`; }

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function triggerImport() { document.getElementById('importFile').click(); }

function importJSON(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      DB.importAll(data);
      renderDashboard();
      showToast(`Imported ${data.plants.length} plants, ${data.logs.length} entries`);
      schedulePush();
    } catch (err) {
      alert('Import failed: ' + err.message);
    }
    input.value = '';
  };
  reader.readAsText(file);
}

// ============================================================
// SETTINGS
// ============================================================
function confirmClearAll() {
  if (confirm('Delete ALL plants and log entries? This cannot be undone.')) {
    localStorage.removeItem(DB.KEY_PLANTS);
    localStorage.removeItem(DB.KEY_LOGS);
    renderDashboard();
    navigate('dashboard');
    showToast('All data cleared');
  }
}

// ============================================================
// SYNC SETUP
// ============================================================
function openSyncSetup() {
  const settings = DB.getSettings();
  document.getElementById('gardenIdInput').value = settings.gardenId || '';
  document.getElementById('syncStatus').style.display = 'none';
  openModal('modalSync');
}

function generateGardenId() {
  document.getElementById('gardenIdInput').value = uuid();
}

async function saveSyncSetup() {
  const id = document.getElementById('gardenIdInput').value.trim();
  if (!id) { showToast('Enter a Garden ID'); return; }
  if (!/^[a-z0-9\-]{8,64}$/.test(id)) {
    showToast('ID must be 8–64 chars: lowercase letters, numbers, hyphens');
    return;
  }

  const s = DB.getSettings();
  s.gardenId = id;
  DB.saveSettings(s);

  const statusEl = document.getElementById('syncStatus');
  statusEl.style.display = 'block';
  statusEl.style.borderRadius = 'var(--rs)';
  statusEl.style.padding = '10px 12px';

  function setStatus(ok, msg) {
    statusEl.style.background = ok ? 'var(--g7)' : '#fdecea';
    statusEl.style.color = ok ? 'var(--g2)' : 'var(--red)';
    statusEl.textContent = msg;
  }

  setStatus(true, 'Connecting…');

  let getRes;
  try {
    getRes = await fetch(`${Sync.endpoint}?id=${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(8000) });
  } catch (e) {
    setSyncDot('error');
    setStatus(false, '✗ Could not reach sync server. Make sure the app is deployed to Netlify — sync does not work when opening the file locally. (' + e.message + ')');
    return;
  }

  if (!getRes.ok) {
    setSyncDot('error');
    let errDetail = '';
    try { const e = await getRes.json(); errDetail = e.detail || e.error || ''; } catch {}
    setStatus(false, `✗ HTTP ${getRes.status} from sync server${errDetail ? ': ' + errDetail : '. Check the Netlify Functions log for this invocation.'}`);
    return;
  }

  const data = await getRes.json();
  if (data && Array.isArray(data.plants) && data.plants.length > 0) {
    DB.importAll(data);
    setSyncDot('ok');
    s.lastSync = new Date().toISOString();
    DB.saveSettings(s);
    setStatus(true, '✓ Synced! Pulled existing data from server.');
    updateSyncDesc();
    renderDashboard();
    setTimeout(() => closeModal('modalSync'), 1800);
    return;
  }

  let postRes;
  try {
    postRes = await fetch(`${Sync.endpoint}?id=${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(DB.exportAll()),
      signal: AbortSignal.timeout(10000)
    });
  } catch (e) {
    setSyncDot('error');
    setStatus(false, '✗ Upload failed: ' + e.message);
    return;
  }

  if (!postRes.ok) {
    setSyncDot('error');
    setStatus(false, `✗ Upload failed (HTTP ${postRes.status}). Check the Netlify Functions log for details.`);
    return;
  }

  setSyncDot('ok');
  s.lastSync = new Date().toISOString();
  DB.saveSettings(s);
  setStatus(true, '✓ Connected! Data uploaded. Use this ID on other devices to sync.');
  updateSyncDesc();
  setTimeout(() => closeModal('modalSync'), 2000);
}

function setSyncDot(state) {
  const dot = document.getElementById('syncDot');
  if (!dot) return;
  dot.className = 'sync-dot' + (state === 'syncing' ? ' syncing' : state === 'error' ? ' error' : '');
}

function updateSyncDesc() {
  const s = DB.getSettings();
  const desc = document.getElementById('syncDesc');
  if (!desc) return;
  if (s.gardenId) {
    const last = s.lastSync ? `Last sync: ${new Date(s.lastSync).toLocaleTimeString()}` : 'Not synced yet';
    desc.textContent = `ID: ${s.gardenId.slice(0,8)}… · ${last}`;
  } else {
    desc.textContent = 'Share your garden across devices';
  }
}

let pushTimer = null;
function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => Sync.push(), 2000);
}

// ============================================================
// MODALS
// ============================================================
function openModal(id) {
  document.getElementById(id).classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeModal(id) {
  document.getElementById(id).classList.remove('open');
  document.body.style.overflow = '';
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
    document.body.style.overflow = '';
    if (document.getElementById('photoViewer').classList.contains('open')) closePhotoViewer();
  }
});

// ============================================================
// TOAST
// ============================================================
let toastTimer = null;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

// ============================================================
// ACTION HELPERS
// ============================================================
const ACTION_EMOJIS = {
  fertilized: '🌿', pruned: '✂️', repotted: '🪴',
  treated: '💊', observed: '👀', harvested: '🌾', other: '📝'
};
function actionEmoji(action) { return ACTION_EMOJIS[action] || '📝'; }

// ============================================================
// INIT
// ============================================================
async function init() {
  updateSyncDesc();

  renderDashboard();

  if (settings.gardenId) {
    Sync.syncIfNeeded();
  }

  if (!DB.getPlants().length) {
    const demoPlants = [
      { id: uuid(), name: 'Tomato — Kitchen window', type: 'Tomato', startDate: '2025-03-01', location: 'Kitchen, south-facing', emoji: '🍅', notes: 'Indeterminate variety, needs staking', active: true, photos: [], createdAt: new Date().toISOString() },
      { id: uuid(), name: 'Basil', type: 'Herb', startDate: '2025-02-15', location: 'Bedroom windowsill', emoji: '🌿', notes: 'Pinch flowers to keep bushy', active: true, photos: [], createdAt: new Date().toISOString() },
      { id: uuid(), name: 'Pothos', type: 'Pothos', startDate: '2024-11-01', location: 'Living room, indirect light', emoji: '🪴', notes: 'Very forgiving, propagates easily', active: true, photos: [], createdAt: new Date().toISOString() },
    ];
    demoPlants.forEach(p => DB.addPlant(p));

    const now = new Date();
    const d = (n) => new Date(now - n * 86400000).toISOString().slice(0, 10);
    const demoLogs = [
      { id: uuid(), plantId: demoPlants[0].id, action: 'fertilized', date: d(7), notes: 'Added liquid tomato feed', photo: null, createdAt: new Date().toISOString() },
      { id: uuid(), plantId: demoPlants[0].id, action: 'observed', date: d(1), notes: 'First flowers appearing!', photo: null, createdAt: new Date().toISOString() },
      { id: uuid(), plantId: demoPlants[1].id, action: 'pruned', date: d(10), notes: 'Pinched back tops', photo: null, createdAt: new Date().toISOString() },
      { id: uuid(), plantId: demoPlants[1].id, action: 'observed', date: d(4), notes: '', photo: null, createdAt: new Date().toISOString() },
      { id: uuid(), plantId: demoPlants[2].id, action: 'observed', date: d(3), notes: 'New leaf unfurling on main stem', photo: null, createdAt: new Date().toISOString() },
    ];
    demoLogs.forEach(l => DB.addLog(l));
    renderDashboard();
  }
}

init();
