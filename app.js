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

const plantCardAge = (startDate) => {
  if (!startDate) return '';
  const days = daysSince(startDate);
  if (days === null || days < 0) return '';
  if (days < 7)   return `${days}d old`;
  if (days < 30)  { const w = Math.floor(days / 7); return `${w}w old`; }
  if (days < 365) { const m = Math.floor(days / 30); const w = Math.floor((days % 30) / 7); return w > 0 ? `${m}mo ${w}w old` : `${m}mo old`; }
  const y = Math.floor(days / 365); const m = Math.floor((days % 365) / 30);
  return m > 0 ? `${y}yr ${m}mo old` : `${y}yr old`;
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
  KEY_KNOWLEDGE: 'gj_knowledge',

  getPlants() { try { return JSON.parse(localStorage.getItem(this.KEY_PLANTS) || '[]'); } catch { return []; } },
  getLogs() { try { return JSON.parse(localStorage.getItem(this.KEY_LOGS) || '[]'); } catch { return []; } },
  getSettings() { try { return JSON.parse(localStorage.getItem(this.KEY_SETTINGS) || '{}'); } catch { return {}; } },
  getKnowledge() { try { return JSON.parse(localStorage.getItem(this.KEY_KNOWLEDGE) || '[]'); } catch { return []; } },

  savePlants(p) { localStorage.setItem(this.KEY_PLANTS, JSON.stringify(p)); },
  saveLogs(l) { localStorage.setItem(this.KEY_LOGS, JSON.stringify(l)); },
  saveSettings(s) { localStorage.setItem(this.KEY_SETTINGS, JSON.stringify(s)); },
  saveKnowledge(k) { localStorage.setItem(this.KEY_KNOWLEDGE, JSON.stringify(k)); },
  updateKnowledgeCard(card) { const a = this.getKnowledge().map(x => x.id === card.id ? card : x); this.saveKnowledge(a); },

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

  exportAll() { return { plants: this.getPlants(), logs: this.getLogs(), settings: this.getSettings(), knowledge: this.getKnowledge(), exportedAt: new Date().toISOString(), version: 1 }; },
  importAll(data) {
    if (!data.plants || !data.logs) throw new Error('Invalid format');
    // Full replace — server is the authoritative snapshot so deletions propagate correctly
    this.savePlants(data.plants);
    this.saveLogs(data.logs);
    if (data.knowledge && Array.isArray(data.knowledge)) {
      this.saveKnowledge(data.knowledge);
    }
  }
};

// ============================================================
// SYNC (Netlify Blobs via serverless function)
// ============================================================
const Sync = {
  endpoint: '/.netlify/functions/sync',

  getGardenId() { return DB.getSettings().gardenId || null; },

  async fetchRemote() {
    const id = this.getGardenId();
    if (!id) return null;
    const res = await fetch(`${this.endpoint}?id=${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data && data.plants) ? data : null;
  },

  async push() {
    const id = this.getGardenId();
    if (!id) return;
    setSyncDot('syncing');
    try {
      const res = await fetch(`${this.endpoint}?id=${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(DB.exportAll()),
        signal: AbortSignal.timeout(10000)
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

  async smartSync() {
    const id = this.getGardenId();
    if (!id) return 'no-id';
    setSyncDot('syncing');
    try {
      const remote = await this.fetchRemote();
      const localModified = DB.getSettings().lastModified || '0';
      const remoteModified = remote?.settings?.lastModified || '0';

      if (!remote || localModified >= remoteModified) {
        // Local is newer (or server is empty) — push
        await this.push();
        return 'pushed';
      } else {
        // Remote is newer — pull
        DB.importAll(remote);
        setSyncDot('ok');
        const s = DB.getSettings(); s.lastSync = new Date().toISOString(); DB.saveSettings(s);
        updateSyncDesc();
        return 'pulled';
      }
    } catch (e) {
      setSyncDot('error');
      console.warn('Smart sync failed:', e);
      return 'error';
    }
  },

  async syncIfNeeded() {
    const id = this.getGardenId();
    if (!id) return;
    const result = await this.smartSync();
    if (result === 'pulled') { renderDashboard(); renderKnowledge(); }
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
  filterPlant: 'all',
  showInactive: false,
  dashSearch: '',
  dashFilterType: 'all',
  dashFilterStatus: 'active'
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
    dashboard: '🌿 Garden Journal <span style="font-size:11px;font-weight:700;background:var(--g7);color:var(--g3);padding:2px 7px;border-radius:20px;vertical-align:middle">v2.0</span>',
    search: 'Search',
    export: 'Export / Import',
    settings: 'Settings'
  }[view];

  if (view === 'search') {
    setTimeout(() => document.getElementById('searchInput').focus(), 100);
    renderSearch();
  }
  if (view === 'dashboard') { renderDashboard(); renderKnowledge(); }
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
  const allPlants = DB.getPlants();

  // Build type filter chips from plants that actually exist
  const types = [...new Set(allPlants.map(p => p.type).filter(Boolean))].sort();

  // Render filter bar (search + status + type chips)
  const filterBar = document.getElementById('dashFilterBar');
  if (filterBar) {
    const statusOptions = [
      { val: 'active', label: 'Active' },
      { val: 'inactive', label: 'Inactive' },
      { val: 'all', label: 'All' }
    ];
    filterBar.innerHTML = `
      <div class="dash-search-wrap">
        <svg class="dash-search-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
        <input class="dash-search-input" id="dashSearchInput" type="search" placeholder="Search plants…" autocomplete="off" value="${esc(state.dashSearch)}" oninput="setDashSearch(this.value)">
        ${state.dashSearch ? `<button class="dash-search-clear" onclick="setDashSearch('')">✕</button>` : ''}
      </div>
      <div class="dash-chips">
        ${statusOptions.map(o => `<button class="chip${state.dashFilterStatus === o.val ? ' active' : ''}" onclick="setDashStatus('${o.val}')">${o.label}</button>`).join('')}
        ${types.length ? `<div class="chip-divider"></div>` : ''}
        ${types.map(t => `<button class="chip${state.dashFilterType === t ? ' active' : ''}" onclick="setDashType('${t}')">${esc(t)}</button>`).join('')}
      </div>`;
  }

  // Apply filters
  let plants = allPlants;
  if (state.dashFilterStatus === 'active') plants = plants.filter(p => p.active !== false);
  else if (state.dashFilterStatus === 'inactive') plants = plants.filter(p => p.active === false);
  if (state.dashFilterType !== 'all') plants = plants.filter(p => p.type === state.dashFilterType);
  if (state.dashSearch) {
    const q = state.dashSearch.toLowerCase();
    plants = plants.filter(p =>
      p.name.toLowerCase().includes(q) ||
      (p.type || '').toLowerCase().includes(q) ||
      (p.location || '').toLowerCase().includes(q)
    );
  }

  // Update count
  const count = document.getElementById('plantCount');
  if (count) count.textContent = plants.length ? `${plants.length} plant${plants.length !== 1 ? 's' : ''}` : '';

  const grid = document.getElementById('plantsGrid');
  if (!allPlants.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <div class="empty-icon">🌱</div>
      <div class="empty-title">No plants yet</div>
      <div class="empty-desc">Tap the <strong>+</strong> button below to add your first plant.</div>
    </div>`;
    return;
  }

  if (!plants.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <div class="empty-icon">🔍</div>
      <div class="empty-title">No matches</div>
      <div class="empty-desc">Try a different search or filter.</div>
    </div>`;
    return;
  }

  grid.innerHTML = plants.map(plant => {
    const inactive = plant.active === false;
    const lastAction = DB.getLastAction(plant.id);
    const daysSinceAny = lastAction ? daysSince(lastAction.date) : null;
    const activityBadge = daysSinceAny !== null
      ? `<span class="badge badge-earth">${actionEmoji(lastAction.action)} ${daysSinceAny === 0 ? 'Today' : daysSinceAny + 'd ago'}</span>` : '';
    const inactiveBadge = inactive ? `<span class="badge badge-inactive">Inactive</span>` : '';
    const age = plantCardAge(plant.startDate);
    const ageBadge = age ? `<span class="badge badge-age">🌱 ${age}</span>` : '';
    return `<div class="plant-card${inactive ? ' inactive' : ''}" onclick="showDetail('${esc(plant.id)}')">
      <div class="plant-card-header">
        <div class="plant-icon">${esc(plant.emoji || '🌱')}</div>
        <div class="plant-card-info">
          <div class="plant-name">${esc(plant.name)}</div>
          ${plant.type ? `<div class="plant-type">${esc(plant.type)}</div>` : ''}
          ${plant.location ? `<div class="plant-location"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>${esc(plant.location)}</div>` : ''}
        </div>
      </div>
      <div class="plant-card-meta">${inactiveBadge}${ageBadge}${activityBadge}</div>
      <div class="plant-card-actions" onclick="event.stopPropagation()">
        <button class="quick-btn quick-btn-note" onclick="openAddLog('${esc(plant.id)}')">📝 Note</button>
      </div>
    </div>`;
  }).join('');
}

function setDashSearch(val) {
  state.dashSearch = val;
  renderDashboard();
  // keep focus in the input
  const inp = document.getElementById('dashSearchInput');
  if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
}
function setDashStatus(val) { state.dashFilterStatus = val; renderDashboard(); }
function setDashType(val) { state.dashFilterType = state.dashFilterType === val ? 'all' : val; renderDashboard(); }
function toggleShowInactive() { state.dashFilterStatus = state.dashFilterStatus === 'inactive' ? 'active' : 'inactive'; renderDashboard(); }

// ============================================================
// KNOWLEDGE: PLANT TYPE EMOJIS
// ============================================================
const PLANT_TYPE_EMOJIS = {
  'Arugula':'🥗','Basil':'🌿','Bay Leaf':'🍃','Bean (Bush)':'🫘',
  'Beet':'🫐','Bell Pepper':'🫑','Blueberry':'🫐','Bok Choy':'🥬',
  'Broccoli':'🥦','Brussels Sprout':'🥦','Catnip':'🌿','Celery':'🥬',
  'Chamomile':'🌼','Chervil':'🌿','Chives':'🌿','Cilantro':'🌿',
  'Cucumber':'🥒','Dill':'🌿','Eggplant':'🍆','Fennel':'🌿',
  'Fig':'🍈','Garlic':'🧄','Green Onion':'🌿','Hot Pepper':'🌶️',
  'Kale':'🥬','Kohlrabi':'🥦','Lavender':'💜','Leek':'🥬',
  'Lemon':'🍋','Lemon Balm':'🌿','Lettuce':'🥗','Lime':'🍈',
  'Marjoram':'🌿','Microgreens':'🌱','Mint':'🌿','Mustard Greens':'🥬',
  'Okra':'🌿','Oregano':'🌿','Parsley':'🌿','Passion Fruit':'🍈',
  'Pea':'🌱','Pomegranate':'🍎','Potato':'🥔','Radish':'🌱',
  'Raspberry':'🍓','Rosemary':'🌿','Sage':'🌿','Shallot':'🧅',
  'Sorrel':'🌿','Spinach':'🥗','Stevia':'🌿','Strawberry':'🍓',
  'Swiss Chard':'🥬','Tarragon':'🌿','Thyme':'🌿','Tomatillo':'🍅',
  'Tomato':'🍅','Turmeric':'🟡','Watercress':'🌿','Zucchini':'🥒'
};
function getPlantTypeEmoji(type) { return PLANT_TYPE_EMOJIS[type] || '🌱'; }

// ============================================================
// RENDER: KNOWLEDGE PANE (dashboard)
// ============================================================
function renderKnowledge() {
  const all = DB.getKnowledge();
  const grid = document.getElementById('knowledgeGrid');
  if (!grid) return;
  // Show cards with content, always show Indoor Gardening Tips
  const cards = all
    .filter(c => c.content || c.category === 'Indoor Gardening Tips')
    .sort((a, b) => {
      if (a.category === 'Indoor Gardening Tips') return -1;
      if (b.category === 'Indoor Gardening Tips') return 1;
      return a.category.localeCompare(b.category);
    });
  if (!cards.length) { grid.innerHTML = '<div class="empty-state" style="padding:24px 0"><div class="empty-icon">🌱</div><div class="empty-title">No knowledge yet</div><div class="empty-desc">Open a plant to start building your knowledge base.</div></div>'; return; }
  grid.innerHTML = cards.map(card => {
    const preview = card.content
      ? card.content.split('\n').filter(l => l.trim()).slice(0, 2).join(' · ')
      : 'Tap to add notes.';
    return `<div class="knowledge-card" onclick="openKnowledgeCard('${esc(card.id)}')">
      <div class="knowledge-card-header">
        <span class="knowledge-emoji">${esc(card.emoji)}</span>
        <span class="knowledge-title">${esc(card.category)}</span>
        <button class="knowledge-edit-btn" onclick="event.stopPropagation();openKnowledgeCard('${esc(card.id)}')">Edit</button>
      </div>
      <div class="knowledge-preview">${esc(preview)}</div>
    </div>`;
  }).join('');
}

function openKnowledgeCard(id) {
  const card = DB.getKnowledge().find(c => c.id === id);
  if (!card) return;
  document.getElementById('knowledgeId').value = card.id;
  document.getElementById('modalKnowledgeTitle').textContent = card.emoji + ' ' + card.category;
  document.getElementById('knowledgeContent').value = card.content || '';
  openModal('modalKnowledge');
  setTimeout(() => document.getElementById('knowledgeContent').focus(), 100);
}

function saveKnowledgeCard() {
  const id = document.getElementById('knowledgeId').value;
  const content = document.getElementById('knowledgeContent').value;
  const cards = DB.getKnowledge();
  const card = cards.find(c => c.id === id);
  if (!card) return;
  card.content = content;
  card.updatedAt = new Date().toISOString();
  DB.updateKnowledgeCard(card);
  closeModal('modalKnowledge');
  renderKnowledge();
  showToast('Saved ✓');
}

// ============================================================
// RENDER: KNOWLEDGE PANE (plant detail, inline auto-save)
// ============================================================
let _kSaveTimer = null;

function getOrCreateKnowledgeCard(type) {
  const all = DB.getKnowledge();
  let card = all.find(c => c.category.toLowerCase() === type.toLowerCase());
  if (!card) {
    card = { id: uuid(), emoji: getPlantTypeEmoji(type), category: type, content: '', updatedAt: new Date().toISOString() };
    all.push(card);
    DB.saveKnowledge(all);
  }
  return card;
}

function renderDetailKnowledge(plant) {
  const pane = document.getElementById('detailKnowledgePane');
  if (!pane) return;
  if (!plant.type) {
    pane.innerHTML = `<div class="section-title"><span>🌱 Knowledge</span></div><div class="knowledge-no-type">Set a plant type to see knowledge notes for this plant.</div>`;
    return;
  }
  const card = getOrCreateKnowledgeCard(plant.type);
  pane.innerHTML = `
    <div class="section-title">
      <span>${esc(getPlantTypeEmoji(plant.type))} ${esc(plant.type)}</span>
      <span class="autosave-indicator" id="autosaveIndicator"></span>
    </div>
    <input type="hidden" id="detailKnowledgeId" value="${esc(card.id)}">
    <textarea class="knowledge-inline-editor" id="detailKnowledgeTextarea"
      placeholder="Add your tips, observations, and notes about ${esc(plant.type)}…"
      oninput="autoSaveDetailKnowledge()">${esc(card.content || '')}</textarea>
  `;
}

function autoSaveDetailKnowledge() {
  const indicator = document.getElementById('autosaveIndicator');
  if (indicator) indicator.textContent = 'Saving…';
  clearTimeout(_kSaveTimer);
  _kSaveTimer = setTimeout(() => {
    const id = document.getElementById('detailKnowledgeId')?.value;
    const content = document.getElementById('detailKnowledgeTextarea')?.value;
    if (!id) return;
    const all = DB.getKnowledge();
    const card = all.find(c => c.id === id);
    if (!card) return;
    card.content = content;
    card.updatedAt = new Date().toISOString();
    DB.saveKnowledge(all);
    if (indicator) { indicator.textContent = 'Saved ✓'; setTimeout(() => { if (indicator) indicator.textContent = ''; }, 2000); }
  }, 700);
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

  renderDetailKnowledge(plant);
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
  document.getElementById('plantStatus').value = 'active';
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
  document.getElementById('plantStatus').value = p.active === false ? 'inactive' : 'active';
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
    active: document.getElementById('plantStatus').value !== 'inactive',
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
let _photoCtx = { photos: [], index: 0, plantStartDate: null, plantId: null };

function openPlantPhoto(plantId, index) {
  const plant = DB.getPlants().find(p => p.id === plantId);
  if (!plant) return;
  _photoCtx = {
    photos: (plant.photos || []).map(ph => ({ src: ph.data, date: ph.date || null })),
    index,
    plantStartDate: plant.startDate || null,
    plantId
  };
  _showPhotoViewer();
}

function openLogPhoto(encodedSrc, photoDate, plantStartDate) {
  _photoCtx = {
    photos: [{ src: decodeURIComponent(encodedSrc), date: photoDate || null }],
    index: 0,
    plantStartDate: plantStartDate || null,
    plantId: null   // log photos are not directly editable here
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

  // Edit date button — only for plant photos
  const editBtn = document.getElementById('photoDateEditBtn');
  editBtn.style.display = _photoCtx.plantId ? '' : 'none';
  cancelEditPhotoDate(); // reset any open editor on nav

  // Info bar visibility
  document.getElementById('photoViewerInfo').style.display = (_photoCtx.plantId || age || photos.length > 1) ? '' : 'none';
}

function startEditPhotoDate() {
  const photo = _photoCtx.photos[_photoCtx.index];
  document.getElementById('photoDateInput').value = photo.date || '';
  document.getElementById('photoDateEditRow').style.display = 'flex';
  document.getElementById('photoDateEditBtn').style.display = 'none';
  document.getElementById('photoDateInput').focus();
}

function cancelEditPhotoDate() {
  document.getElementById('photoDateEditRow').style.display = 'none';
  if (_photoCtx.plantId) document.getElementById('photoDateEditBtn').style.display = '';
}

function savePhotoDate() {
  const newDate = document.getElementById('photoDateInput').value;
  const { plantId, index } = _photoCtx;
  if (!plantId) return;

  const plants = DB.getPlants();
  const plant = plants.find(p => p.id === plantId);
  if (!plant || !plant.photos || !plant.photos[index]) return;

  plant.photos[index].date = newDate || null;
  DB.savePlants(plants);

  // Update in-memory ctx and re-render frame
  _photoCtx.photos[index].date = newDate || null;
  cancelEditPhotoDate();
  _renderPhotoFrame();
  schedulePush();
  showToast('Date saved ✓');
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
  const syncNowRow = document.getElementById('syncNowRow');
  const headerSyncBtn = document.getElementById('headerSyncBtn');
  if (!desc) return;
  if (s.gardenId) {
    const last = s.lastSync ? `Last sync: ${new Date(s.lastSync).toLocaleTimeString()}` : 'Not synced yet';
    desc.textContent = `ID: ${s.gardenId.slice(0,8)}… · ${last}`;
    if (syncNowRow) syncNowRow.style.display = '';
    if (headerSyncBtn) headerSyncBtn.style.display = '';
  } else {
    desc.textContent = 'Share your garden across devices';
    if (syncNowRow) syncNowRow.style.display = 'none';
    if (headerSyncBtn) headerSyncBtn.style.display = 'none';
  }
}

async function runSync(btnId, descId, btnLabel) {
  const btn = document.getElementById(btnId);
  const desc = document.getElementById(descId);
  const icon = document.getElementById('headerSyncIcon');
  if (btn) { btn.disabled = true; if (btnLabel) btn.textContent = '…'; }
  if (icon) icon.style.animation = 'spin 1s linear infinite';
  if (desc) desc.textContent = 'Checking…';
  try {
    const result = await Sync.smartSync();
    if (result === 'pulled') { renderDashboard(); renderKnowledge(); showToast('Updated from cloud ✓'); if (desc) desc.textContent = 'Updated from cloud ✓'; }
    else if (result === 'pushed') { showToast('Uploaded to cloud ✓'); if (desc) desc.textContent = 'Uploaded to cloud ✓'; }
    else if (result === 'error') { showToast('Sync failed'); if (desc) desc.textContent = 'Sync failed — check connection'; }
  } finally {
    if (btn) { btn.disabled = false; if (btnLabel) btn.textContent = btnLabel; }
    if (icon) icon.style.animation = '';
    updateSyncDesc();
  }
}

function headerSync() { runSync('headerSyncBtn', null, null); }
function forcSync()   { runSync('syncNowBtn', 'syncNowDesc', 'Sync'); }

let pushTimer = null;
function schedulePush() {
  // Stamp lastModified so smartSync knows local is newer than server
  const s = DB.getSettings();
  s.lastModified = new Date().toISOString();
  DB.saveSettings(s);
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

  // Seed knowledge cards — re-seed on major version change
  if (DB.getSettings().knowledgeVersion !== '2') {
    const knowledgeCards = [
      { id: uuid(), emoji: '🏠', category: 'Indoor Gardening Tips',
        content: `Light: Most edibles need 6–8h direct sun or 12–16h under grow lights.\nSoil: Always use potting mix — never garden soil. Add 20–30% perlite for drainage.\nWatering: Overwatering is the #1 killer. Check 2 inches deep before watering.\nHumidity: 40–60% is ideal. Group plants or use a pebble tray with water.\nFertilizing: Feed every 2–4 weeks with balanced liquid fertilizer during growing season.\nTemperature: Most edibles prefer 65–80°F (18–27°C). Keep away from cold drafts.\nRotation: Turn pots a quarter-turn weekly so all sides get equal light.\nPests: Yellow sticky traps catch fungus gnats. Neem oil handles most soft-bodied insects.\nAir circulation: A small fan on low improves stem strength and reduces mould.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🥗', category: 'Arugula',
        content: `One of the easiest greens to grow indoors. Ready to harvest in 30–40 days.\nLight: 4–6h — one of the most shade-tolerant edibles.\nSowing: Scatter seeds on moist soil, barely cover. Germinate in 3–7 days.\nHarvest: Cut outer leaves at 3–4 inches. Centre regrows for multiple harvests.\nBolting: Arugula bolts quickly in heat. Keep cool (60–68°F / 15–20°C) for best flavour.\nFlavour tip: Harvest young for mild, nutty flavour. Older leaves are more peppery.\nSuccession sow every 2–3 weeks for continuous harvest.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🌿', category: 'Basil',
        content: `Needs warmth and bright light — at least 6h sun or 14h grow lights.\nPinch flower buds immediately as they appear; flowering stops leaf production.\nHarvest: Always cut above a leaf node so two new shoots grow back.\nWatering: Keep soil moist but not soggy. Water at the base — wet leaves cause fungal issues.\nTemperature: Below 50°F (10°C) causes blackening. Keep warm at all times.\nVarieties: Genovese (classic), Thai basil (more heat tolerant), lemon basil.\nPropagate easily: Place a stem cutting in water; roots appear in 1–2 weeks.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🍃', category: 'Bay Leaf',
        content: `Slow-growing but long-lived. One plant provides years of harvest.\nLight: 4–6h of bright indirect light. Tolerates lower light than most herbs.\nWatering: Allow soil to dry slightly between waterings. Very drought-tolerant once established.\nHarvest: Pick individual leaves as needed. Always leave plenty of foliage on the plant.\nGrowth: Expect slow growth — may only put out a few new leaves per month.\nPruning: Prune to maintain shape. Pruned stems can be used as cuttings.\nNote: Fresh bay leaves are much stronger in flavour than dried — use half as many.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🫘', category: 'Bean (Bush)',
        content: `Bush beans are compact and well-suited for large containers indoors.\nLight: 8+ hours of bright light — one of the more demanding crops.\nContainer: At least 12 inches deep. Pot up as plant grows.\nPlanting: Sow seeds 1 inch deep, 3 inches apart. Germinate in 7–10 days.\nWatering: Keep consistently moist. Avoid wetting foliage.\nFertilizing: Light feeder — too much nitrogen = leafy plant, few pods.\nHarvest: Pick pods when slender and before seeds bulge (50–60 days).\nNote: Bush beans are generally more practical indoors than pole beans.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🫐', category: 'Beet',
        content: `Grow beets for greens as much as roots — both are edible and nutritious.\nLight: 6h minimum. Roots develop better with more light.\nContainer: At least 12 inches deep for good root development.\nThinning: Thin seedlings to 3 inches apart — beet "seeds" are actually clusters.\nHarvest (greens): At any size for salads. Harvest roots at golf-ball to tennis-ball size.\nWatering: Keep consistently moist. Drought causes woody, bitter roots.\nFertilizing: Low nitrogen (causes leafy growth over roots). Use balanced or root fertilizer.\nGermination: Soak seeds 2h before planting to speed up the 7–14 day germination.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🫑', category: 'Bell Pepper',
        content: `Compact varieties best for indoors: Carnival, Pot-a-Pep, Baby Belle.\nLight: 8+ hours or 16h under grow lights. Insufficient light = no fruit.\nPollination: Shake gently or use a brush between flowers.\nTemperature: 70–85°F (21–29°C) for best fruit set. Cool temps delay ripening.\nWatering: Consistent moisture. Inconsistent watering causes blossom drop.\nRipening: Green → yellow → orange → red. Each stage has different flavour.\nFertilizing: High potassium fertilizer once flowering begins.\nOverwintering: Cut back in fall and keep indoors. Peppers are perennial.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🫐', category: 'Blueberry',
        content: `Possible indoors with the right variety and care — requires patience.\nBest varieties: Northblue, Patriot, Top Hat (dwarf, perfect for pots).\nSoil: Acidic is critical — pH 4.5–5.5. Use ericaceous compost or add sulphur.\nLight: 8+ hours of bright light. Grow lights help in Canadian winters.\nPollination: Two varieties improve fruit set, but self-fertile types exist.\nChill hours: Most blueberries need 400–800 hours below 45°F to fruit. Check variety.\nFertilizing: Use acid fertilizer (for rhododendrons/azaleas). Avoid lime.\nContainer: Large pot (5+ gallons). Repot every 2–3 years.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🥬', category: 'Bok Choy',
        content: `Fast-growing cool-season crop. Baby bok choy ready in 30 days; full size in 45–60.\nLight: 4–6h. Tolerates lower light better than most brassicas.\nTemperature: 60–70°F (15–21°C). Heat causes bolting.\nWatering: Keep consistently moist — wilting stresses the plant quickly.\nHarvest (baby): At 4–6 inches, cut whole plant at base.\nHarvest (full): Harvest outer leaves, or cut whole head.\nSowing: Direct sow 2 seeds per cell, thin to strongest seedling.\nNote: A great succession crop — sow every 3 weeks for continuous harvest.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🥦', category: 'Broccoli',
        content: `Best grown as microgreens or baby shoots indoors — full heads need too much space and light.\nMicrogreens: Ready in 8–12 days. Dense sowing, harvest at cotyledon or first true leaf stage.\nBaby shoots: Harvest at 4–6 inches for a broccolini-style tender shoot.\nLight: 6+ hours for shoots. 8+ hours for any attempt at full heads.\nTemperature: Prefers cool (60–70°F / 15–21°C). Heat causes bolting.\nSoil: Rich, moisture-retaining mix. Broccoli is a heavy feeder.\nNote: Full broccoli heads indoors are rarely practical — focus on the greens.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🌼', category: 'Chamomile',
        content: `German chamomile (annual) is easier to grow than Roman chamomile (perennial).\nLight: 4–6h of bright light. Tolerates some shade.\nSowing: Scatter seeds on soil surface — they need light to germinate. Do not cover.\nGermination: 7–14 days. Keep soil moist during this period.\nHarvest: Pick flowers when fully open. Dry on a screen in a warm, airy spot.\nDrying: Air-dry for 1–2 weeks. Store in airtight jar away from light.\nTea: 1 tbsp dried flowers per cup boiling water, steep 5 minutes.\nNote: Will self-seed if you let some flowers go to seed.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🌿', category: 'Chervil',
        content: `Delicate anise-flavoured herb. Underused but excellent in the garden.\nLight: Prefers partial shade — 3–4h. One of the few herbs that does better with less light.\nTemperature: Cool-season herb (50–65°F / 10–18°C). Bolts quickly in heat.\nSowing: Direct sow — does not transplant well. Germination in 7–14 days.\nHarvest: Cut outer leaves once plant reaches 6 inches. Harvest before flowering.\nUse: Excellent in French cuisine — salads, sauces, fish, eggs.\nBolting: Once it flowers, leaves lose flavour. Succession sow every 3–4 weeks.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🌿', category: 'Chives',
        content: `One of the most reliable, low-maintenance herbs for indoors.\nLight: 4–6h — tolerates lower light than most herbs.\nWatering: Moderate. Let soil dry slightly between waterings.\nHarvest: Cut to 1–2 inches from the base. Regrows quickly and repeatedly.\nFlowers: Edible — beautiful in salads. But pinching off prolongs leaf harvest.\nDivision: Divide clumps every year or two to keep them vigorous.\nGrowth: Goes dormant in winter if placed in a cold spot. Keep warm for year-round harvest.\nPropagation: Divide existing clumps or grow from seed (slow, 2–3 weeks germination).`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🌿', category: 'Cilantro',
        content: `Fastest-bolting herb — succession sow every 2–3 weeks for continuous supply.\nLight: 4–6h. Bolts faster in high heat and bright light — moderate light helps.\nTemperature: Prefers cool (60–70°F / 15–21°C). Heat triggers bolting.\nSowing: Direct sow — dislikes transplanting. Lightly crush seeds before sowing.\nHarvest: Cut outer stems once 6 inches tall. Never take more than 1/3 at once.\nBolting: Once flower stalks appear, harvest everything — leaves lose flavour quickly.\nBonus: Let it bolt and harvest the coriander seeds when the plant dries out.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🥒', category: 'Cucumber',
        content: `Best indoor varieties: Bush Pickle, Patio Snacker, Spacemaster, Salad Bush.\nLight: Very demanding — 8+ hours bright sun or strong grow lights.\nPollination: Male flowers appear first (no bump behind petal). Female flowers have a tiny cucumber. Transfer pollen with a soft brush or cotton swab.\nSupport: Train vines up a trellis or bamboo stake to save space.\nWatering: Keep consistently moist. Inconsistent watering = bitter, misshapen fruit.\nHarvesting: Pick every 2–3 days to encourage more fruit. Don't let them over-ripen.\nIdeal temp: 70–85°F (21–29°C). Cold stresses the plant significantly.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🌿', category: 'Dill',
        content: `Fast-growing, feathery herb. Best grown in successive sowings.\nLight: 6–8h of bright light. Dill gets leggy without adequate light.\nHeight: Can reach 3 feet — choose dwarf varieties (Fernleaf) for containers.\nSowing: Direct sow — resents transplanting. Germinates in 7–14 days.\nHarvest: Snip fronds from the top before flowers form.\nBolting: Bolts in heat. Harvest frequently to delay.\nSeeds: Once flowering, let some go to seed — dill seeds are also excellent in cooking.\nCompanion note: Keep away from fennel — they cross-pollinate and affect flavour.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🍆', category: 'Eggplant',
        content: `Requires high light and warmth — one of the more challenging indoor crops.\nLight: 8+ hours. Insufficient light = no fruit.\nVarieties: Slim Japanese or Thai types are more compact and productive indoors.\nPollination: Self-pollinating but benefits from gentle shaking or a brush.\nTemperature: 70–85°F (21–29°C). Very sensitive to cold — below 55°F damages plants.\nWatering: Keep consistently moist. Drought causes bitter, spongy flesh.\nFertilizing: High potassium once flowering. Heavy feeder overall.\nHarvest: Pick when skin is glossy. Dull skin = overripe and seedy.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🌿', category: 'Fennel',
        content: `Grow Florence fennel for bulbs; common fennel for fronds and seeds.\nLight: 6–8h of bright light. Gets leggy without enough.\nContainer: Deep pot (12+ inches) — fennel has a long taproot.\nWatering: Moderate. Allow top inch to dry between waterings.\nHarvest (fronds): Snip as needed once plant is established.\nHarvest (bulb): Harvest Florence fennel when bulb reaches tennis-ball size.\nNote: Keep away from most other plants — fennel is allelopathic (inhibits growth of neighbours).\nSeeds: Let some plants bolt and collect seeds for cooking.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🍈', category: 'Fig',
        content: `A rewarding indoor tree with the right variety and space.\nBest varieties: Petite Negra, Little Miss Figgy, Brown Turkey (compact).\nLight: 6–8h of bright direct sun. A south-facing window is ideal.\nContainer: Start in a 10–12 inch pot. Repot every 2–3 years.\nWatering: Allow top 2 inches to dry between waterings. Very drought-tolerant.\nDormancy: Loses leaves in winter — this is normal. Reduce watering during dormancy.\nFertilizing: Feed monthly during growing season with balanced fertilizer.\nHarvest: Figs are ripe when they hang slightly, feel soft, and may weep a drop of nectar.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🧄', category: 'Garlic',
        content: `Planting: Break bulb into cloves, plant pointed-end up, 1 inch deep.\nLight: 6–8h. Tolerates slightly lower light than most vegetables.\nWatering: Water when the top inch of soil is dry. Do not overwater.\nHarvest (greens): Snip tops at any time for fresh garlic flavour — they regrow.\nHarvest (bulbs): Takes 8–9 months. Better suited to outdoor growing for full bulbs.\nQuick crop: Plant multiple cloves close together; harvest greens continuously like herbs.\nContainer: At least 6 inches deep for greens; 8–12 inches for bulbs.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🌿', category: 'Green Onion',
        content: `Easiest indoor vegetable — regrow from store-bought root ends.\nWater method: Place roots in 1 inch of water. Change water every 2 days. Harvest repeatedly for weeks.\nSoil method: Transplant rooted scraps to soil for more robust growth and flavour.\nFrom seed: Ready in 3–4 weeks. Sow densely, thin to 1 inch apart.\nHarvest: Snip from top, always leaving 1+ inch of green so the plant regrows.\nLight: 4–6h — one of the most shade-tolerant edibles.\nNo fertilizer needed for water-grown plants. Feed soil-grown ones monthly.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🌶️', category: 'Hot Pepper',
        content: `Best compact varieties: NuMex Twilight, Tabasco, Lemon Drop, Thai chili.\nLight: 8+ hours or 16h under grow lights — same as tomatoes.\nPollination: Shake gently or use a brush. Mostly self-pollinating.\nOverwintering: Cut back by 2/3 in autumn, keep bright and warm. Peppers are perennial — same plant for years.\nHeat: Mild water stress during fruiting increases capsaicin (heat) in hot varieties.\nFertilizing: High potassium when fruiting. Avoid excess nitrogen.\nTemp: Ideal 70–85°F (21–30°C). Sensitive to cold — keep above 55°F.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🥬', category: 'Kale',
        content: `Cold-hardy and nutritious — one of the best winter indoor crops.\nLight: 4–6h — performs well under grow lights.\nVarieties: Dwarf Siberian, Redbor, or Lacinato (Tuscan/dinosaur kale) for containers.\nHarvest: Cut outer leaves only; the plant keeps producing from the centre.\nFlavour: Flavour improves after a cold snap — move near a cool window in winter.\nContainer: At least 8 inches deep. Kale has significant roots.\nFertilizing: Feed every 3–4 weeks with nitrogen-rich fertilizer for leafy growth.\nSow to harvest: About 55–70 days from seed.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🥦', category: 'Kohlrabi',
        content: `Fast-growing, space-efficient brassica. The bulb (actually a swollen stem) is the edible part.\nLight: 6h minimum. More light = faster growth.\nTemperature: Cool-season crop (60–70°F / 15–21°C). Bolts in sustained heat.\nThinning: Thin to 4–5 inches apart for bulb development.\nHarvest: Pick bulbs at 2–3 inches diameter — before they get woody.\nSow to harvest: 45–60 days.\nFlavour: Mild, crispy, slightly sweet — like the heart of broccoli.\nNote: Both the bulb and the leaves are edible (leaves cook like kale).`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '💜', category: 'Lavender',
        content: `Needs excellent drainage and strong light — the most common failure is overwatering.\nLight: 6–8h bright direct sun. Grows leggy and weak without enough.\nSoil: Well-draining, slightly alkaline (add lime or perlite generously).\nWatering: Allow to dry out fully between waterings. Lavender is very drought-tolerant.\nTemperature: Prefers cooler nights (55–65°F / 13–18°C) — helps trigger blooming.\nPruning: After flowering, cut back by 1/3 to keep bushy and prevent woodiness.\nVarieties: Hidcote and Vera are more compact and better for containers.\nNote: French lavender (L. dentata) adapts better to indoor conditions.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🥬', category: 'Leek',
        content: `Slow-growing but space-efficient. Grow baby leeks for faster results.\nLight: 6+ hours. More light = thicker, more flavourful stems.\nContainer: 8–10 inches deep. Grow multiple leeks per pot.\nHarvest (baby leeks): At pencil thickness, 60–70 days. Harvest whole plant.\nHarvest (full leeks): 100–130 days. Pull when stem base is 1+ inch thick.\nBlanching: Mound soil around the base to keep stems white and mild.\nFrom scraps: Stand leek root base in water to regrow green tops for fresh flavour.\nFertilizing: Nitrogen-heavy feed every 3–4 weeks.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🍋', category: 'Lemon',
        content: `Meyer lemon is the best choice for indoors — smaller, more cold-tolerant, and reliably fruiting.\nLight: 8+ hours of direct sun. A south-facing window is ideal.\nContainer: 10–14 inch pot with excellent drainage.\nWatering: Let top 2 inches dry between waterings. Never let roots sit in water.\nHumidity: 50%+ humidity is important. Mist regularly or use a humidifier.\nPollination: Hand-pollinate with a brush during flowering.\nFertilizing: Citrus-specific fertilizer (high nitrogen + micronutrients) every 4–6 weeks.\nNote: Dropping leaves = usually overwatering or temperature shock.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🌿', category: 'Lemon Balm',
        content: `Easy-to-grow, vigorous herb with a mild lemon scent. Great for teas.\nLight: 4–6h. Tolerates lower light than most herbs.\nGrowth: Very vigorous — trim regularly to prevent legginess and keep bushy.\nWatering: Moderate. Tolerates both dry and moist conditions.\nHarvest: Cut stems back by half regularly. Encourages bushy, productive growth.\nUse: Fresh leaves in tea, salads, desserts. Dried for tea.\nNote: Closely related to mint — same vigorous growth habits. Give it its own pot.\nPropagation: Easily divided or grown from cuttings in water.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🥗', category: 'Lettuce',
        content: `One of the easiest indoor crops — tolerates lower light than most edibles.\nVarieties: Loose-leaf types (Black Seeded Simpson, Oak Leaf, Butterhead) are best for cut-and-come-again.\nHarvest: Take outer leaves only, letting the centre keep growing. One plant can produce for months.\nSuccession planting: Sow a few seeds every 2–3 weeks for continuous harvest.\nTemperature: Prefers cool conditions 60–70°F (15–21°C). Bolts and turns bitter in heat.\nGermination: Soak seeds overnight in cool water for faster sprouting.\nLight: 3–5h is enough. Lettuce is the most shade-tolerant edible food crop.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🍈', category: 'Lime',
        content: `Kaffir lime (for leaves) and Persian lime are the best indoor choices.\nLight: 8+ hours of bright direct sun. Essential for fruiting.\nKaffir lime: Grow for the aromatic leaves used in Southeast Asian cooking. Less demanding than fruiting types.\nWatering: Let top 2 inches dry between waterings. Good drainage is critical.\nHumidity: Citrus needs 50%+ humidity. Dry air causes leaf drop.\nFertilizing: Citrus-specific fertilizer every 4–6 weeks in growing season.\nPollination: Hand-pollinate flowers with a soft brush.\nTemp: Keep above 55°F at all times. No cold drafts.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🌿', category: 'Marjoram',
        content: `Milder, sweeter cousin of oregano. Often grown as an annual indoors.\nLight: 6h of bright light. Similar requirements to oregano and thyme.\nWatering: Allow to dry between waterings. Mediterranean herb — drought tolerant.\nHarvest: Cut stems back by 1/3 regularly. Harvest before flowers fully open for best flavour.\nUse: Italian cooking, soups, meat dishes. Substitute for oregano but sweeter.\nPropagation: Easy from cuttings — place stem in water until roots appear.\nNote: Tender marjoram (sweet marjoram) is the most commonly grown variety for cooking.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🌱', category: 'Microgreens',
        content: `Fastest indoor crop — most varieties ready in 7–14 days from seed.\nBest varieties: Radish, sunflower, peas, broccoli, kale, arugula, basil, red cabbage.\nSetup: Shallow tray (1–2 inches deep), potting mix or coco coir, dense seed sowing.\nGermination: Cover with a second tray or dome for 3–4 days — moisture + darkness.\nHarvesting: Cut just above soil line when cotyledons fully open (or first true leaf).\nLight: Once uncovered, bright light or grow lights to prevent legginess.\nNo fertilizer needed — seeds carry all nutrients for this short growth stage.\nRinse and eat immediately for best flavour and nutrition.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🌿', category: 'Mint',
        content: `Extremely vigorous — always grow in its own pot to prevent takeover.\nLight: 3–6h. One of the most shade-tolerant herbs.\nWatering: Prefers consistently moist soil — unlike most herbs.\nHarvest: Cut stems back by half frequently. Encourages dense, bushy growth.\nPinching: Pinch off flowers to keep leaves coming. Flowering reduces flavour.\nVarieties: Spearmint (most common), peppermint (stronger), chocolate mint, apple mint.\nPropagation: Place any stem cutting in water — roots in 1 week. Almost impossible to kill.\nNote: Mint spreads aggressively via underground runners. Pot containment is essential.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🥬', category: 'Mustard Greens',
        content: `Fast-growing, spicy greens. One of the easiest indoor crops.\nLight: 4–6h. Tolerates lower light well.\nTemperature: Cool-season crop — bolts quickly in heat above 75°F.\nSow to harvest: 20–40 days for baby greens; 45–60 days for full leaves.\nHarvest: Cut-and-come-again method. Outer leaves first.\nFlavour: Baby leaves are mild; mature leaves are peppery and strong.\nSuccession sow: Every 2–3 weeks for continuous supply.\nNote: Very cold tolerant — can handle near-freezing temps making it a great winter crop.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🌿', category: 'Okra',
        content: `One of the more challenging crops indoors due to light and heat requirements.\nLight: 8+ hours. Grow lights almost essential in Canada.\nTemperature: Tropical crop — needs consistent warmth, 75–90°F (24–32°C).\nContainer: At least 3 gallons. Dwarf varieties (Baby Bubba, Dwarf Long Pod) are most practical.\nWatering: Moderate. Allow top inch to dry between waterings.\nHarvest: Pick pods at 3–4 inches — larger pods become tough and fibrous. Harvest every 2–3 days.\nNote: Plants grow tall — be prepared for a 3–4 foot plant indoors.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🌿', category: 'Oregano',
        content: `Drought-tolerant Mediterranean herb — thrives with neglect (within reason).\nLight: 6–8h of bright light. The most important factor for flavour concentration.\nWatering: Allow to dry fully between waterings. Overwatering is the main risk.\nHarvest: Cut stems back by 1/3 regularly before flowers open.\nFlavour: Strongest just before flowering — harvest heavily at this point.\nVarieties: Greek oregano is the most intensely flavoured. Italian oregano is milder.\nPropagation: Easy from cuttings in water or direct in soil.\nDrying: Easy to dry — hang bunches upside down for 1–2 weeks.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🌿', category: 'Parsley',
        content: `Slow to germinate but reliable once established. Biennial — best grown as annual.\nLight: 4–6h. One of the more shade-tolerant culinary herbs.\nGermination: 3–4 weeks. Soak seeds 24h in warm water to speed germination.\nHarvest: Always cut outer stems from the base. Leave inner stems to continue growing.\nNote: Second-year plants bolt quickly — replace annually for consistent harvest.\nVarieties: Flat-leaf (Italian) has stronger flavour; curly is milder and more decorative.\nWatering: Keep consistently moist — parsley dislikes drying out.\nFertilizing: Monthly with balanced fertilizer.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🌱', category: 'Pea',
        content: `Dwarf and bush varieties are most practical for indoor growing.\nVarieties: Tom Thumb, Little Marvel, Sugar Ann (snap pea), Snowflake.\nLight: 6h minimum. More light = more pods.\nTemperature: Cool-season crop (55–70°F / 13–21°C). Heat stops pod production.\nSupport: Even dwarf types benefit from a small trellis or sticks.\nWatering: Keep consistently moist. Do not let soil dry out during flowering.\nSow to harvest: 55–70 days.\nPollination: Self-pollinating — no assistance needed.\nNote: Peas fix nitrogen — great companion for container herbs after harvest.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🥔', category: 'Potato',
        content: `Container potatoes are fun and surprisingly productive with the right setup.\nVarieties: Fingerling, Yukon Gold, or "new potato" types — choose smaller/faster varieties.\nContainer: Large bag or 5-gallon pot. "Grow bag" method works best indoors.\nPlanting: Chit (pre-sprout) seed potatoes for 2 weeks in light before planting.\nLight: 6+ hours. More light = better yield.\nHilling: Cover stems as they grow — each buried stem produces more potatoes.\nHarvest: After tops die back (90–120 days). Dig up entire container.\nWatering: Consistent moisture, especially once tubers begin forming.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🌱', category: 'Radish',
        content: `One of the fastest crops indoors — ready in 20–30 days.\nLight: 4–6h. Lower light produces more leaves, less root development.\nContainer: At least 6 inches deep. Don't crowd — thin to 2 inches apart.\nTemperature: Cool-season crop (50–65°F / 10–18°C). Heat causes pithy, hot roots.\nSow to harvest: 20–30 days (round types), 60 days (daikon/long types).\nHarvest: Don't delay — radishes become hollow and very hot if left too long.\nSuccession sow: Every 2 weeks for continuous harvest.\nNote: Daikon and French Breakfast types grow well indoors; Cherry Belle is classic.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🍓', category: 'Raspberry',
        content: `Compact and heritage varieties can produce indoors with commitment.\nBest varieties: Heritage, Raspberry Shortcake (thornless, dwarf), Autumn Bliss.\nLight: 8+ hours. Grow lights help in Canada's short winters.\nContainer: 5+ gallon, deep pot.\nChill requirement: Most raspberries need winter chill hours (below 45°F). Autumn-bearing types are easier.\nWatering: Consistent moisture but well-drained. Roots must never sit in water.\nFertilizing: Balanced feed in spring; high potassium when fruiting.\nNote: Raspberry Shortcake is bred for container growing and is the most practical choice.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🌿', category: 'Rosemary',
        content: `Needs excellent drainage and strong light. Most common cause of death is root rot.\nLight: 6–8h direct sun. Struggles in low-light Canadian winters — use grow lights.\nWatering: Allow to dry out almost completely between waterings.\nSoil: Very well-draining — add 30% perlite or use a cactus mix.\nHumidity: Rosemary actually prefers drier air. Keep away from humidifiers.\nPruning: Prune after flowering to maintain shape. Don't cut into old woody stems.\nPropagation: Stem cuttings root easily in water or perlite.\nNote: Yellow, dropping needles = usually overwatering. Pale, leggy = not enough light.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🌿', category: 'Sage',
        content: `Woody Mediterranean herb. Easy once established with the right conditions.\nLight: 6–8h of bright direct light.\nWatering: Allow soil to dry between waterings. Drought-tolerant once established.\nHarvest: Cut young stem tips regularly to keep the plant bushy.\nFlavour: Strongest just before and during flowering.\nPruning: Cut back by 1/3 after flowering. Avoid cutting into old wood.\nVarieties: Common sage (Salvia officinalis) is best for cooking. Purple and tricolor varieties are decorative but also edible.\nNote: Sage is slow-growing — don't over-harvest a young plant.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🧅', category: 'Shallot',
        content: `Easier to grow indoors than onions due to smaller size.\nPlanting: Push shallot sets 1 inch into soil, tip just visible.\nLight: 6h minimum. More light = more vigorous growth.\nContainer: At least 6 inches deep. Can grow multiple per pot.\nWatering: Moderate. Allow top inch to dry between waterings.\nHarvest (greens): Snip tops at any time like green onions.\nHarvest (bulbs): When tops begin to yellow and fall over (90–120 days).\nStorage: Dry in a warm, airy spot for 2–3 weeks before storing.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🌿', category: 'Sorrel',
        content: `Perennial herb with a pleasantly sour, lemony flavour. Underrated for indoor growing.\nLight: 4–6h. Tolerates partial shade well.\nWatering: Keep consistently moist. Sorrel dislikes drying out.\nHarvest: Cut outer leaves regularly. Goes dormant in deep winter but regrows.\nFlavour: Young leaves are mild; older leaves are sharper and more acidic.\nUse: Soups, sauces, salads, eggs. Classic French sorrel soup.\nNote: Let the plant establish for a full season before heavy harvesting.\nDivision: Divide clumps every 2–3 years to keep productive.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🥗', category: 'Spinach',
        content: `Cool-season crop — perfect for indoor growing in Canadian winters.\nLight: 3–5h — very shade-tolerant. Excellent under grow lights.\nTemperature: 50–65°F (10–18°C). Bolts quickly above 75°F.\nSow to harvest: Baby leaves in 25 days; full leaves in 40–50 days.\nHarvest: Cut-and-come-again. Take outer leaves and the plant regrows.\nBolting: Hot temperatures or long days trigger bolting. Harvest quickly when it starts.\nVarieties: Bloomsdale is a reliable standby. Tyee and Melody are bolt-resistant.\nFertilizing: Nitrogen-rich feed for leafy growth. Feed every 3–4 weeks.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🌿', category: 'Stevia',
        content: `Natural sweetener herb — leaves are 200–300× sweeter than sugar.\nLight: 6–8h of bright light. Needs warmth and sun to produce sweet leaves.\nWatering: Keep consistently moist but never waterlogged.\nHarvest: Cut stems back regularly — more branching = more leaves.\nFlavour: Sweetness is highest just before flowering. Harvest heavily at this point.\nDrying: Air dry leaves and crumble for use as a sweetener.\nTemperature: Tropical plant — needs 65–85°F. Does not tolerate frost.\nNote: Can be grown as a perennial if kept warm and brought indoors before frost.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🍓', category: 'Strawberry',
        content: `Day-neutral varieties (Albion, Seascape, Tristar) produce year-round indoors.\nLight: 6–8h bright sun or 12+ hours under grow lights.\nSoil: Slightly acidic (pH 5.5–6.5). Add a little peat to standard potting mix.\nRunners: Remove to focus energy on fruit. Pot separately if you want new plants.\nPollination: Brush flowers with a soft paintbrush for better fruit set indoors.\nFertilizing: High-potassium fertilizer when flowers and fruit appear.\nReplanting: Replace plants every 2–3 years — yield declines with age.\nContainer: At least 8 inches wide and deep. Hanging baskets work well.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🥬', category: 'Swiss Chard',
        content: `Ornamental and edible — colourful stems make a stunning indoor plant.\nLight: 4–6h. More shade-tolerant than most brassicas.\nVarieties: Rainbow chard (multi-coloured) is beautiful. Fordhook Giant is very productive.\nHarvest: Cut outer leaves at the base. Centre keeps producing.\nSow to harvest: 50–60 days for full size; 30 days for baby leaves.\nContainer: At least 8 inches deep.\nFertilizing: Nitrogen-rich feed every 3–4 weeks.\nNote: Handle leaves gently — stems and leaves bruise easily. Harvest into a bowl, not a bag.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🌿', category: 'Tarragon',
        content: `French tarragon (not Russian) is the variety used in cooking — must be grown from division, not seed.\nLight: 6h of bright light.\nWatering: Allow to dry slightly between waterings. Moderate drought tolerance.\nNote: Only French tarragon has genuine anise flavour. Russian tarragon grown from seed has very little flavour.\nHarvest: Cut stems back by half regularly. Harvest before flowering for best flavour.\nDormancy: Goes dormant in winter — this is normal. Resume watering when new growth appears.\nPropagation: Division or stem cuttings only (French tarragon is sterile — no viable seeds).\nUse: Classic French cuisine — Béarnaise sauce, chicken, fish, eggs.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🌿', category: 'Thyme',
        content: `Very hardy, drought-tolerant herb. One of the easiest to grow indoors.\nLight: 6h of bright light. Flavour is most concentrated with maximum light.\nWatering: Allow to dry fully between waterings. Root rot is the main risk.\nHarvest: Clip stem tips regularly. Harvest before or during flowering for peak flavour.\nPruning: After flowering, cut back by 1/3 to prevent woodiness.\nVarieties: Common thyme (Thymus vulgaris) is best for cooking. Lemon thyme is a fragrant alternative.\nPropagation: Very easy from stem cuttings in water.\nNote: Thyme is a perennial — one plant can last many years with good care.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🍅', category: 'Tomatillo',
        content: `Papery-husked relative of tomato. Underused for indoor growing but very rewarding.\nLight: 8+ hours or strong grow lights.\nPollination: Tomatillos are NOT self-fertile — you need at least TWO plants.\nGrowth: Vigorous grower — stake or cage as for tomatoes.\nHusk: The papery husk splits and fruit is ripe when it fills the husk and turns yellow/purple.\nFertilizing: Same as tomatoes — switch to high-potassium when flowering.\nTemp: 65–85°F (18–29°C). Similar to tomatoes in requirements.\nUse: Salsa verde, Mexican cooking. Unique tart flavour different from tomatoes.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🍅', category: 'Tomato',
        content: `Best indoor varieties: Tiny Tim, Tumbling Tom, Micro Tom, Sweet 100, Red Robin.\nLight: 8+ hours bright sun or 16h under grow lights.\nPollination: Shake flowering stems gently daily, or use a small brush between flowers.\nSupport: Indeterminate types need staking or caging. Bush types stay compact.\nWatering: Keep consistently moist. Irregular watering = blossom end rot and cracking.\nFertilizing: Switch to high-phosphorus/potassium fertilizer when flowers appear.\nPruning: Pinch suckers on indeterminate varieties for better yield and airflow.\nIdeal temp: 65–80°F (18–27°C). Below 55°F stops fruit set.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🟡', category: 'Turmeric',
        content: `Tropical rhizome — grows as an ornamental plant with edible reward.\nPlanting: Plant fresh turmeric rhizome (from grocery store) 2 inches deep.\nLight: Bright indirect light. Tolerates lower light than most tropical crops.\nTemperature: Needs warmth — 65–85°F (18–29°C). Very frost-sensitive.\nGrowth: Dramatic, leafy tropical appearance. Grows 3–4 feet tall.\nHarvest: After 8–10 months, when leaves yellow and die back. Dig up rhizomes.\nStorage: Cure at room temperature for 1 week then store in a cool, dry place.\nNote: Grows slowly — be patient. The harvest is worth the wait.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🌿', category: 'Watercress',
        content: `Aquatic herb — easiest grown in a water container indoors.\nWater method: Place stems in a container of water changed every 2–3 days. Grows rapidly.\nSoil method: Keep soil very wet (set pot in a tray of water). More flavourful result.\nLight: 4–6h. Tolerates indirect light well.\nHarvest: Cut stems regularly. Always leave several leaves so the plant regrows.\nFlavour: Peppery and bright. Best used fresh — doesn't cook well.\nNote: Use filtered or aged tap water — chlorine can inhibit growth.\nSow to harvest: 3–4 weeks from seed.`,
        updatedAt: new Date().toISOString() },
      { id: uuid(), emoji: '🥒', category: 'Zucchini',
        content: `Possible indoors with very strong light — a fun challenge.\nVarieties: Bush types only: Patio Star, Eight Ball, Bush Baby.\nLight: 8+ hours — one of the most light-hungry crops.\nContainer: At least 5 gallons. Large plant with big roots.\nPollination: Manual essential. Male flowers (long thin stem) appear first. Transfer pollen to female flowers (tiny zucchini behind petal) with a brush.\nHarvest: Pick at 6–8 inches. Waiting longer slows production and stresses the plant.\nWatering: Heavy drinker — check daily. Wilt quickly when dry.\nNote: Expect a large, sprawling plant. Best grown near a big south window.`,
        updatedAt: new Date().toISOString() },
      {
        id: uuid(), emoji: '🌿', category: 'Green Onions',
        content: `Regrowing from scraps: Place store-bought root ends in 1 inch of water. Roots appear within days.\nWater method: Change water every 2 days. Harvest outer leaves and they keep regrowing for weeks.\nSoil method: Transplant rooted scraps to soil for more robust growth and flavour.\nFrom seed: Ready in 3–4 weeks. Sow densely, thin to 1 inch apart.\nHarvesting: Snip from the top, always leaving at least 1 inch of green so the plant regrows.\nLight: 4–6h of light is enough — one of the most shade-tolerant edibles.\nNo fertilizer needed for water-grown plants. Feed soil-grown ones monthly.`,
        updatedAt: new Date().toISOString()
      },
      {
        id: uuid(), emoji: '🥬', category: 'Celery',
        content: `Regrowing from scraps: Cut base 2 inches from bottom, place cut-side up in a shallow dish of water.\nRoots and new shoots appear in 5–7 days. Transplant to soil once roots reach 1–2 inches.\nLight: 6+ hours or grow lights. One of the more light-demanding regrow crops.\nWatering: Never let celery dry out — it needs consistently moist soil.\nTemperature: Prefers cooler temps 60–70°F (15–21°C). Bolts in heat.\nTimeline: 3–5 months from transplant to harvestable stalks.\nSoil: Rich, moisture-retaining potting mix. Add compost if available.\nFertilizing: Feed every 2 weeks with nitrogen-rich fertilizer for leafy growth.`,
        updatedAt: new Date().toISOString()
      },
      {
        id: uuid(), emoji: '🥒', category: 'Cucumber',
        content: `Best indoor varieties: Bush Pickle, Patio Snacker, Spacemaster, Salad Bush.\nLight: Very demanding — 8+ hours bright sun or strong grow lights. This is non-negotiable.\nPollination: Male flowers appear first (no bump behind petal). Female flowers have a tiny cucumber behind them. Transfer pollen with a soft brush or cotton swab.\nSupport: Train vines up a trellis or bamboo stake. Saves space and improves airflow.\nWatering: Keep soil consistently moist. Inconsistent watering causes bitter, misshapen fruit.\nHarvesting: Pick frequently (every 2–3 days) to encourage more fruit. Don't let them over-ripen.\nIdeal temp: 70–85°F (21–29°C). Cold stresses the plant significantly.`,
        updatedAt: new Date().toISOString()
      },
      {
        id: uuid(), emoji: '🍓', category: 'Strawberries',
        content: `Best varieties for indoors: Day-neutral types (Albion, Seascape, Tristar) produce year-round regardless of day length.\nLight: 6–8h bright sun or 12+ hours under grow lights.\nSoil: Slightly acidic (pH 5.5–6.5). Add a little peat moss to standard potting mix.\nRunners: Remove them to focus energy on fruit production. Pot them separately if you want new plants.\nPollination: Gently brush flowers with a soft paintbrush for better fruit set indoors.\nFertilizing: Use high-potassium fertilizer when flowers and fruit appear.\nReplanting: Replace plants every 2–3 years — yield declines with age.\nContainer: At least 8 inches wide and deep. Hanging baskets work well for runners.`,
        updatedAt: new Date().toISOString()
      },
      {
        id: uuid(), emoji: '🌶️', category: 'Peppers',
        content: `Best compact varieties: Lunchbox, NuMex Twilight, Tabasco, Chenzo, Redskin.\nLight: Very high — 8+ hours or 16h under grow lights. Similar demands to tomatoes.\nPollination: Shake plants gently or use a small brush. Peppers are mostly self-pollinating.\nOverwintering: Cut back by 2/3 in autumn and keep in a bright spot. Peppers are perennial — same plant can produce for years.\nHeat and capsaicin: Mild water stress during fruiting increases heat in hot varieties.\nFertilizing: Balanced feed while growing; switch to high-potassium when fruiting.\nTemp: Ideal 70–85°F (21–30°C). Very sensitive to cold — keep above 55°F at all times.`,
        updatedAt: new Date().toISOString()
      },
      {
        id: uuid(), emoji: '🥗', category: 'Lettuce & Greens',
        content: `One of the easiest indoor crops — tolerates lower light than most edibles.\nVarieties: Loose-leaf types (Black Seeded Simpson, Oak Leaf, Butterhead) are best for cut-and-come-again.\nHarvesting: Take outer leaves only, letting the center keep growing. One plant can produce for months.\nSuccession planting: Sow a few seeds every 2–3 weeks for a continuous harvest.\nTemperature: Prefers cool conditions 60–70°F (15–21°C). Bolts and turns bitter in heat.\nGermination tip: Soak seeds in cool water overnight for faster sprouting.\nSpinach & arugula follow the same general rules — all great for indoor growing.`,
        updatedAt: new Date().toISOString()
      },
      {
        id: uuid(), emoji: '🌱', category: 'Herbs',
        content: `Basil: Loves heat and full sun. Pinch flower buds as soon as they appear to keep leaves coming.\nMint: Extremely vigorous — always grow in its own pot or it takes over. Tolerates partial shade.\nParsley: Slow to germinate (3 weeks). Keep soil consistently moist. Does well in lower light.\nChives: Very easy. Cut to 1 inch and they regrow. Tolerates lower light than most herbs.\nCilantro: Bolts quickly in heat. Sow in cool conditions. Harvest before it flowers.\nThyme & Oregano: Drought-tolerant Mediterranean herbs. Full sun essential. Easy to overwater.\nRosemary: Needs excellent drainage and strong light. Most common cause of death is root rot from overwatering.`,
        updatedAt: new Date().toISOString()
      },
      {
        id: uuid(), emoji: '🌾', category: 'Microgreens',
        content: `Fastest indoor crop — most varieties ready in 7–14 days from seed.\nBest varieties to start: Radish, sunflower, peas, broccoli, kale, arugula, basil.\nSetup: Shallow tray (1–2 inches deep), potting mix or coco coir, dense seed sowing.\nGermination: Cover with a second tray or dome for 3–4 days to retain moisture and darkness.\nHarvesting: Cut just above the soil line when first true leaves appear (or at cotyledon stage).\nLight: Once uncovered, they need bright light or grow lights to avoid legginess.\nNo fertilizer needed — seeds carry all nutrients for this stage.\nRinse and eat immediately after cutting for best flavour and nutrition.`,
        updatedAt: new Date().toISOString()
      },
    ];
    DB.saveKnowledge(knowledgeCards);
    const s = DB.getSettings(); s.knowledgeVersion = '2'; DB.saveSettings(s);
  }

  renderDashboard();
  renderKnowledge();

  if (DB.getSettings().gardenId) {
    Sync.syncIfNeeded();
  }

  if (!DB.getPlants().length) {
    const demoPlants = [
      { id: uuid(), name: 'Tomato — Kitchen window', type: 'Fruit', startDate: '2025-03-01', location: 'Kitchen, south-facing', emoji: '🍅', notes: 'Indeterminate variety, needs staking', active: true, photos: [], createdAt: new Date().toISOString() },
      { id: uuid(), name: 'Basil', type: 'Herb', startDate: '2025-02-15', location: 'Bedroom windowsill', emoji: '🌿', notes: 'Pinch flowers to keep bushy', active: true, photos: [], createdAt: new Date().toISOString() },
      { id: uuid(), name: 'Pothos', type: 'Other', startDate: '2024-11-01', location: 'Living room, indirect light', emoji: '🪴', notes: 'Very forgiving, propagates easily', active: true, photos: [], createdAt: new Date().toISOString() },
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
