// ============================================================
// Wget App - Renderer Process
// Handles UI rendering, user interaction, and IPC communication
// ============================================================

// ----- Icon Map -----
const ICON_MAP = {
  'globe': '\u{1F310}',
  'code': '\u{1F4BB}',
  'film': '\u{1F3AC}',
  'tool': '\u{1F527}',
  'shield': '\u{1F6E1}\uFE0F',
  'message-circle': '\u{1F4AC}',
  'file-text': '\u{1F4C4}',
  'cpu': '\u2699\uFE0F',
  'brain': '\u{1F9E0}',
  'gamepad': '\u{1F3AE}'
};

// ----- State -----
let currentCategory = null;
let currentGroupId = null;
let categories = [];
let groups = [];
const softwareData = {};
const installedStatus = {};
let queueActive = false;

// ----- i18n -----
let currentLang = localStorage.getItem('lang') || 'en';
let i18n = {};

async function loadI18n(lang) {
  const response = await fetch(`data/i18n/${lang}.json`);
  i18n = await response.json();
}

function t(key) {
  return i18n[key] || key;
}

// ----- DOM References -----
const sidebarNav = document.getElementById('sidebar-nav');
const categoryTitle = document.getElementById('category-title');
const cardsGrid = document.getElementById('cards-grid');
const searchInput = document.getElementById('search');
const updateBadge = document.getElementById('update-badge');
const openDownloadsBtn = document.getElementById('open-downloads');
const refreshInstalledBtn = document.getElementById('refresh-installed');
const groupsNav = document.getElementById('groups-nav');
const newGroupBtn = document.getElementById('new-group-btn');
const importGroupBtn = document.getElementById('import-group-btn');
const groupModal = document.getElementById('group-modal');
const groupModalTitle = document.getElementById('group-modal-title');
const groupNameInput = document.getElementById('group-name-input');
const groupSearchInput = document.getElementById('group-search-input');
const groupSoftwareList = document.getElementById('group-software-list');
const groupSelectedCount = document.getElementById('group-selected-count');
const groupSaveBtn = document.getElementById('group-save-btn');
const groupCancelBtn = document.getElementById('group-cancel-btn');
const queuePanel = document.getElementById('queue-panel');
const queueItems = document.getElementById('queue-items');
const queueCancelBtn = document.getElementById('queue-cancel-btn');
const queueCloseBtn = document.getElementById('queue-close-btn');

// ============================================================
// Initialization
// ============================================================

async function init() {
  await loadI18n(currentLang);
  document.documentElement.lang = currentLang;
  updateToggleButtons();

  // Apply i18n to static labels right away (sidebar titles, search placeholder)
  document.querySelector('.sidebar-title').textContent = t('sidebar.title');
  document.getElementById('groups-title').textContent = t('groups.title');
  searchInput.placeholder = t('search.placeholder');
  importGroupBtn.title = t('groups.import');
  newGroupBtn.title = t('groups.new');

  try {
    // 1. Categories + all category JSONs + cached-installed in parallel.
    //    None of these block on the slow registry+Appx scan.
    const [catsRes, cachedInstalled] = await Promise.all([
      fetch('data/categories.json').then(r => r.json()),
      (window.electronAPI && window.electronAPI.getCachedInstalled
        ? window.electronAPI.getCachedInstalled()
        : Promise.resolve({}))
    ]);
    categories = catsRes;

    if (cachedInstalled) Object.assign(installedStatus, cachedInstalled);

    // Load all category JSONs in parallel so category switching is instant
    // and so we can run one full checkInstalled against the complete catalog.
    await Promise.all(categories.map(async (cat) => {
      if (softwareData[cat.id]) return;
      try {
        const res = await fetch(`data/${cat.id}.json`);
        softwareData[cat.id] = await res.json();
      } catch (err) {
        console.error(`Failed to load ${cat.id}.json:`, err);
        softwareData[cat.id] = [];
      }
    }));

    renderSidebar(categories);

    if (categories.length > 0) {
      await selectCategory(categories[0].id);
    }

    setupProgressListener();
    setupSearchHandler();
    setupLangToggle();
    setupUpdateBadge();
    setupDownloadsButton();
    setupRefreshButton();
    await loadGroups();
    setupGroupModal();
    setupQueuePanel();

    // 2. Fire the authoritative installed-scan in the background.
    //    If scan is already cached fresh from app-ready kickoff, this is instant.
    //    Otherwise it takes ~1-3s, badges update in-place when ready (no full re-render).
    refreshInstalledStatusForAll().then(() => {
      if (currentCategory) patchInstalledBadgesInPlace();
    });
  } catch (err) {
    console.error('Failed to initialize app:', err);
    showToast(t('error.loadCategories'), 'error');
  }
}

// ============================================================
// Sidebar Rendering
// ============================================================

function renderSidebar(cats) {
  sidebarNav.innerHTML = '';

  cats.forEach((cat, index) => {
    const btn = document.createElement('button');
    btn.className = 'sidebar-tab';
    if (index === 0) btn.classList.add('active');
    btn.dataset.categoryId = cat.id;

    const iconSpan = document.createElement('span');
    iconSpan.className = 'tab-icon';
    iconSpan.textContent = ICON_MAP[cat.icon] || cat.icon;

    const labelSpan = document.createElement('span');
    labelSpan.className = 'tab-label';
    labelSpan.textContent = currentLang === 'en' ? (cat.name_en || cat.name) : cat.name;

    const countSpan = document.createElement('span');
    countSpan.className = 'tab-count';
    countSpan.textContent = '...';

    btn.appendChild(iconSpan);
    btn.appendChild(labelSpan);
    btn.appendChild(countSpan);

    btn.addEventListener('click', () => selectCategory(cat.id));

    sidebarNav.appendChild(btn);

    // Load count asynchronously
    loadCategoryCount(cat.id, countSpan);
  });
}

async function loadCategoryCount(categoryId, countSpan) {
  try {
    if (!softwareData[categoryId]) {
      const response = await fetch(`data/${categoryId}.json`);
      const data = await response.json();
      softwareData[categoryId] = data;
    }
    countSpan.textContent = softwareData[categoryId].length;
  } catch (err) {
    countSpan.textContent = '0';
  }
}

// ============================================================
// Category Selection
// ============================================================

async function selectCategory(categoryId) {
  currentCategory = categoryId;
  currentGroupId = null;

  // Update active tab in sidebar
  const tabs = sidebarNav.querySelectorAll('.sidebar-tab');
  tabs.forEach(tab => {
    tab.classList.toggle('active', tab.dataset.categoryId === categoryId);
  });
  groupsNav.querySelectorAll('.sidebar-tab').forEach(tab => tab.classList.remove('active'));

  // Update header title
  const cat = categories.find(c => c.id === categoryId);
  if (cat) {
    categoryTitle.textContent = currentLang === 'en' ? (cat.name_en || cat.name) : cat.name;
  }

  // Clear search when changing categories
  searchInput.value = '';

  // Category JSONs are pre-loaded by init(); lazy-load only if somehow missing.
  if (!softwareData[categoryId]) {
    try {
      const response = await fetch(`data/${categoryId}.json`);
      softwareData[categoryId] = await response.json();
    } catch (err) {
      console.error(`Failed to load category data for ${categoryId}:`, err);
      showToast(t('error.loadData'), 'error');
      softwareData[categoryId] = [];
    }
  }

  // installedStatus is populated from cache at init() and refreshed in the
  // background by refreshInstalledStatusForAll — no per-category scan here.
  renderCards();
}

// ============================================================
// Card Rendering
// ============================================================

function renderCards() {
  cardsGrid.innerHTML = '';

  const searchTerm = searchInput.value.trim().toLowerCase();
  const isCrossSearch = searchTerm.length > 0;

  // Build list of { sw, cat } — cat is null when not in cross-search mode
  let items = [];
  if (isCrossSearch) {
    for (const cat of categories) {
      const list = softwareData[cat.id] || [];
      for (const sw of list) {
        if (sw.name.toLowerCase().includes(searchTerm)) {
          items.push({ sw, cat });
        }
      }
    }
  } else {
    const list = softwareData[currentCategory] || [];
    items = list.map(sw => ({ sw, cat: null }));
  }

  if (items.length === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'empty-state';
    emptyDiv.innerHTML = `
      <div class="empty-state-icon">\u{1F50D}</div>
      <div class="empty-state-title">${t('empty.title')}</div>
      <div class="empty-state-description">${searchTerm ? t('empty.search') + ' "' + escapeHtml(searchTerm) + '"' : t('empty.description')}.</div>
    `;
    cardsGrid.appendChild(emptyDiv);
    return;
  }

  items.forEach(({ sw, cat }) => cardsGrid.appendChild(createCardElement(sw, cat)));
}

function createCardElement(sw, cat) {
  const isInstalled = installedStatus[sw.id] === true;

  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = sw.id;
  card.dataset.name = sw.name;
  if (isInstalled) card.classList.add('installed');

  // Card header
  const header = document.createElement('div');
  header.className = 'card-header';

  const nameSpan = document.createElement('span');
  nameSpan.className = 'card-name';
  nameSpan.textContent = sw.name;
  header.appendChild(nameSpan);

  if (isInstalled) {
    const badge = document.createElement('span');
    badge.className = 'installed-badge';
    header.appendChild(badge);
  }

  // Category chip (only shown in cross-category search)
  if (cat) {
    const chip = document.createElement('span');
    chip.className = 'category-chip';
    chip.textContent = currentLang === 'en' ? (cat.name_en || cat.name) : cat.name;
    header.appendChild(chip);
  }

  // Description
  const desc = document.createElement('p');
  desc.className = 'card-description';
  desc.textContent = currentLang === 'en' ? (sw.description_en || sw.description) : sw.description;

  // Footer
  const footer = document.createElement('div');
  footer.className = 'card-footer';

  const sizeSpan = document.createElement('span');
  sizeSpan.className = 'card-size';
  sizeSpan.textContent = sw.size || '';
  footer.appendChild(sizeSpan);

  const progressText = document.createElement('span');
  progressText.className = 'progress-text';
  progressText.style.display = 'none';
  footer.appendChild(progressText);

  const homepageUrl = getHomepageUrl(sw);
  if (homepageUrl) {
    const link = document.createElement('button');
    link.className = 'card-homepage';
    link.type = 'button';
    link.innerHTML = `&#127760; <span class="card-homepage-label"></span>`;
    link.querySelector('.card-homepage-label').textContent = t('card.projectLabel');
    link.title = t('card.projectLink');
    link.addEventListener('click', (e) => {
      e.stopPropagation();
      if (window.electronAPI && window.electronAPI.openExternal) {
        window.electronAPI.openExternal(homepageUrl);
      }
    });
    footer.appendChild(link);
  }

  // Progress bar
  const progressContainer = document.createElement('div');
  progressContainer.className = 'progress-bar-container';

  const progressBar = document.createElement('div');
  progressBar.className = 'progress-bar';
  progressContainer.appendChild(progressBar);

  card.appendChild(header);
  card.appendChild(desc);
  card.appendChild(footer);
  card.appendChild(progressContainer);

  card.addEventListener('click', () => handleDownload(sw, card));

  return card;
}

function getHomepageUrl(sw) {
  if (sw.homepage) return sw.homepage;
  if (sw.source === 'github' && sw.repo) return `https://github.com/${sw.repo}`;
  return null;
}

// ============================================================
// Download Handler
// ============================================================

async function handleDownload(software, card) {
  // If already downloading, ignore
  if (card.classList.contains('downloading')) {
    return;
  }

  // If already installed, show toast and return
  if (installedStatus[software.id] === true) {
    showToast(t('toast.alreadyInstalled'), 'warning');
    return;
  }

  // Browser-source entries: no wget-compatible direct link exists
  // (e.g. vendors with ever-changing URLs), open the download page instead
  if (software.source === 'browser') {
    const url = software.downloadUrl || getHomepageUrl(software);
    if (url && window.electronAPI && window.electronAPI.openExternal) {
      window.electronAPI.openExternal(url);
      showToast(t('toast.openingBrowser'), 'success');
    }
    return;
  }

  // Start downloading state
  card.classList.add('downloading');
  card.classList.remove('error');

  // Show indeterminate progress bar
  const progressBar = card.querySelector('.progress-bar');
  const progressText = card.querySelector('.progress-text');
  if (progressBar) {
    progressBar.classList.add('indeterminate');
    progressBar.style.width = '';
  }
  if (progressText) {
    progressText.style.display = '';
    progressText.textContent = t('toast.downloading');
  }

  try {
    if (window.electronAPI && window.electronAPI.downloadSoftware) {
      await window.electronAPI.downloadSoftware(software);
      showToast(t('toast.downloadComplete'), 'success');

      // Mark progress as complete
      if (progressBar) {
        progressBar.classList.remove('indeterminate');
        progressBar.classList.add('complete');
      }
    } else {
      throw new Error('electronAPI not available');
    }
  } catch (err) {
    console.error('Download failed:', err);
    card.classList.add('error');
    showToast(`${t('toast.error')}${err.message || 'Download failed'}`, 'error');

    // Reset progress bar on error
    if (progressBar) {
      progressBar.classList.remove('indeterminate');
      progressBar.style.width = '0%';
    }
    if (progressText) {
      progressText.style.display = 'none';
    }
  } finally {
    card.classList.remove('downloading');
  }
}

// ============================================================
// Progress Listener
// ============================================================

function setupProgressListener() {
  if (window.electronAPI && window.electronAPI.onDownloadProgress) {
    window.electronAPI.onDownloadProgress((data) => {
      const { id, progress } = data;
      const card = cardsGrid.querySelector(`.card[data-id="${id}"]`);
      if (!card) return;

      const progressBar = card.querySelector('.progress-bar');
      const progressText = card.querySelector('.progress-text');

      if (progressBar && typeof progress === 'number') {
        progressBar.classList.remove('indeterminate');
        progressBar.style.width = `${Math.round(progress)}%`;
      }

      if (progressText && typeof progress === 'number') {
        progressText.style.display = '';
        progressText.textContent = `${Math.round(progress)}%`;
      }

      // Mirror progress into the install-queue panel row, if present
      const qStatus = queueItems.querySelector(`.queue-row[data-id="${id}"] .queue-status`);
      if (qStatus && typeof progress === 'number') {
        qStatus.textContent = `${Math.round(progress)}%`;
      }
    });
  }
}

// ============================================================
// Search Handler
// ============================================================

function setupSearchHandler() {
  let debounce;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      const term = searchInput.value.trim();
      if (term.length > 0) {
        // Cross-category search: ensure all category data is loaded
        await ensureAllCategoriesLoaded();
      }
      if (currentGroupId) renderGroupView();
      else renderCards();
    }, 120);
  });
}

let allCategoriesLoadPromise = null;
function ensureAllCategoriesLoaded() {
  if (!allCategoriesLoadPromise) {
    allCategoriesLoadPromise = Promise.all(
      categories.map(async (cat) => {
        if (softwareData[cat.id]) return;
        try {
          const res = await fetch(`data/${cat.id}.json`);
          softwareData[cat.id] = await res.json();
        } catch (err) {
          console.error(`Failed to load ${cat.id}.json:`, err);
          softwareData[cat.id] = [];
        }
      })
    ).then(() => refreshInstalledStatusForAll());
  }
  return allCategoriesLoadPromise;
}

async function refreshInstalledStatusForAll() {
  const all = [];
  for (const list of Object.values(softwareData)) {
    if (Array.isArray(list)) all.push(...list);
  }
  if (!all.length) return;
  try {
    if (window.electronAPI && window.electronAPI.checkInstalled) {
      const results = await window.electronAPI.checkInstalled(all);
      if (results) Object.assign(installedStatus, results);
    }
  } catch (err) {
    console.error('Failed to refresh installed status:', err);
  }
}

// ============================================================
// Update Badge (auto-update UI in header)
// ============================================================

let updateStateCache = { flavor: null };

function setupUpdateBadge() {
  if (!window.electronAPI || !window.electronAPI.updates) return;

  const api = window.electronAPI.updates;

  api.onState((state) => {
    updateStateCache = state;
    renderUpdateBadge();
  });

  updateBadge.addEventListener('click', () => handleUpdateBadgeClick());

  api.getState().then((state) => {
    updateStateCache = state;
    renderUpdateBadge();
  }).catch(() => {});
}

function renderUpdateBadge() {
  const state = updateStateCache;
  if (!state || !state.flavor) {
    updateBadge.hidden = true;
    return;
  }

  updateBadge.hidden = false;
  updateBadge.classList.remove('downloading', 'ready');

  if (state.downloaded) {
    updateBadge.classList.add('ready');
    updateBadge.textContent = t('update.ready').replace('{version}', state.version || '');
    updateBadge.disabled = false;
  } else if (state.downloading) {
    updateBadge.classList.add('downloading');
    updateBadge.textContent = t('update.downloading').replace('{percent}', String(state.progress || 0));
    updateBadge.disabled = true;
  } else {
    updateBadge.textContent = t('update.available').replace('{version}', state.version || '');
    updateBadge.disabled = false;
  }
}

async function handleUpdateBadgeClick() {
  const state = updateStateCache;
  if (!state || !state.flavor) return;
  const api = window.electronAPI && window.electronAPI.updates;
  if (!api) return;

  if (state.flavor === 'portable') {
    api.openReleasePage();
    return;
  }

  if (state.downloaded) {
    api.quitAndInstall();
  } else if (!state.downloading) {
    api.startDownload();
  }
}

// ============================================================
// Open downloads folder button
// ============================================================

function setupDownloadsButton() {
  if (!openDownloadsBtn) return;
  openDownloadsBtn.addEventListener('click', () => {
    if (window.electronAPI && window.electronAPI.openDownloadsFolder) {
      window.electronAPI.openDownloadsFolder();
    }
  });
}

function setupRefreshButton() {
  if (!refreshInstalledBtn) return;
  refreshInstalledBtn.addEventListener('click', async () => {
    if (refreshInstalledBtn.classList.contains('spinning')) return;
    const api = window.electronAPI;
    if (!api || !api.refreshInstalled) return;

    refreshInstalledBtn.classList.add('spinning');
    refreshInstalledBtn.disabled = true;
    showToast(t('toast.refreshing'), 'info');

    try {
      await api.refreshInstalled();
      await refreshInstalledStatusForAllFresh();
      patchInstalledBadgesInPlace();
      showToast(t('toast.refreshed'), 'success');
    } catch (err) {
      console.error('Refresh failed:', err);
      showToast(`${t('toast.error')}${err.message || 'refresh failed'}`, 'error');
    } finally {
      refreshInstalledBtn.classList.remove('spinning');
      refreshInstalledBtn.disabled = false;
    }
  });
}

// Update only the installed-badge on existing cards without rebuilding the
// whole grid. Avoids the visual "flash" of renderCards() clearing + re-adding
// every card when only a few badges actually changed.
function patchInstalledBadgesInPlace() {
  const cards = cardsGrid.querySelectorAll('.card');
  cards.forEach(card => {
    const id = card.dataset.id;
    const nowInstalled = installedStatus[id] === true;
    const wasInstalled = card.classList.contains('installed');
    if (nowInstalled === wasInstalled) return;

    card.classList.toggle('installed', nowInstalled);
    const existingBadge = card.querySelector('.installed-badge');
    if (nowInstalled && !existingBadge) {
      const badge = document.createElement('span');
      badge.className = 'installed-badge';
      const header = card.querySelector('.card-header');
      if (header) {
        const chip = header.querySelector('.category-chip');
        if (chip) header.insertBefore(badge, chip);
        else header.appendChild(badge);
      }
    } else if (!nowInstalled && existingBadge) {
      existingBadge.remove();
    }
  });
}

async function refreshInstalledStatusForAllFresh() {
  const all = [];
  for (const list of Object.values(softwareData)) {
    if (Array.isArray(list)) all.push(...list);
  }
  if (!all.length) return;
  try {
    if (window.electronAPI && window.electronAPI.checkInstalled) {
      const results = await window.electronAPI.checkInstalled(all);
      if (results) {
        // Clear keys that are no longer installed (user uninstalled something)
        for (const key of Object.keys(installedStatus)) {
          if (results[key] === false) delete installedStatus[key];
        }
        Object.assign(installedStatus, results);
      }
    }
  } catch (err) {
    console.error('Failed fresh installed status scan:', err);
  }
}

// ============================================================
// Language Toggle
// ============================================================

function setupLangToggle() {
  document.getElementById('lang-en').addEventListener('click', () => switchLang('en'));
  document.getElementById('lang-it').addEventListener('click', () => switchLang('it'));
}

async function switchLang(lang) {
  if (lang === currentLang) return;
  currentLang = lang;
  localStorage.setItem('lang', lang);
  await loadI18n(lang);
  document.documentElement.lang = lang;
  updateToggleButtons();
  document.getElementById('search').placeholder = t('search.placeholder');
  document.querySelector('.sidebar-title').textContent = t('sidebar.title');
  document.getElementById('groups-title').textContent = t('groups.title');
  importGroupBtn.title = t('groups.import');
  newGroupBtn.title = t('groups.new');
  renderSidebar(categories);
  renderGroupsNav();
  if (currentGroupId) {
    const group = groups.find(g => g.id === currentGroupId);
    if (group) categoryTitle.textContent = group.name;
    renderGroupView();
  } else if (currentCategory) {
    const cat = categories.find(c => c.id === currentCategory);
    if (cat) {
      document.getElementById('category-title').textContent =
        currentLang === 'en' ? (cat.name_en || cat.name) : cat.name;
    }
    renderCards();
  }
  renderUpdateBadge();
  if (openDownloadsBtn) {
    openDownloadsBtn.title = t('tooltip.openDownloads');
  }
  if (refreshInstalledBtn) {
    refreshInstalledBtn.title = t('tooltip.refreshInstalled');
  }
}

function updateToggleButtons() {
  document.getElementById('lang-en').classList.toggle('active', currentLang === 'en');
  document.getElementById('lang-it').classList.toggle('active', currentLang === 'it');
}

// ============================================================
// Toast Notifications
// ============================================================

function showToast(message, type = 'info') {
  // Only show the most recent toast — dismiss any existing ones
  document.querySelectorAll('.toast').forEach(t => t.remove());

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    if (toast.parentNode) {
      toast.remove();
    }
  }, 4000);
}

// ============================================================
// Custom Groups (user "loadouts")
// ============================================================

async function loadGroups() {
  if (window.electronAPI && window.electronAPI.groups) {
    try {
      groups = await window.electronAPI.groups.getAll();
    } catch (err) {
      console.error('Failed to load groups:', err);
      groups = [];
    }
  }
  renderGroupsNav();
}

function renderGroupsNav() {
  groupsNav.innerHTML = '';
  groups.forEach(g => {
    const btn = document.createElement('button');
    btn.className = 'sidebar-tab';
    btn.dataset.groupId = g.id;
    if (g.id === currentGroupId) btn.classList.add('active');

    const iconSpan = document.createElement('span');
    iconSpan.className = 'tab-icon';
    iconSpan.textContent = '\u{1F4E6}';

    const labelSpan = document.createElement('span');
    labelSpan.className = 'tab-label';
    labelSpan.textContent = g.name;

    const countSpan = document.createElement('span');
    countSpan.className = 'tab-count';
    countSpan.textContent = g.softwareIds.length;

    btn.appendChild(iconSpan);
    btn.appendChild(labelSpan);
    btn.appendChild(countSpan);
    btn.addEventListener('click', () => selectGroup(g.id));
    groupsNav.appendChild(btn);
  });
}

function findSoftwareById(id) {
  for (const list of Object.values(softwareData)) {
    if (!Array.isArray(list)) continue;
    const hit = list.find(sw => sw.id === id);
    if (hit) return hit;
  }
  return null;
}

function getGroupSoftware(group) {
  const seen = new Set();
  const out = [];
  for (const id of group.softwareIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const sw = findSoftwareById(id);
    if (sw) out.push(sw); // ids removed from the catalog are silently skipped
  }
  return out;
}

function selectGroup(groupId) {
  const group = groups.find(g => g.id === groupId);
  if (!group) return;
  currentGroupId = groupId;
  currentCategory = null;

  sidebarNav.querySelectorAll('.sidebar-tab').forEach(tab => tab.classList.remove('active'));
  groupsNav.querySelectorAll('.sidebar-tab').forEach(tab =>
    tab.classList.toggle('active', tab.dataset.groupId === groupId));

  categoryTitle.textContent = group.name;
  searchInput.value = '';
  renderGroupView();
}

function renderGroupView() {
  const group = groups.find(g => g.id === currentGroupId);
  if (!group) return;
  cardsGrid.innerHTML = '';

  // Action bar: install all / edit / delete
  const bar = document.createElement('div');
  bar.className = 'group-actions';

  const installBtn = document.createElement('button');
  installBtn.className = 'modal-btn modal-btn-primary';
  installBtn.type = 'button';
  installBtn.textContent = t('groups.installAll');
  installBtn.title = t('groups.installAllHint');
  installBtn.addEventListener('click', () => startQueue(group));

  const editBtn = document.createElement('button');
  editBtn.className = 'modal-btn';
  editBtn.type = 'button';
  editBtn.textContent = t('groups.edit');
  editBtn.addEventListener('click', () => openGroupModal(group));

  const exportBtn = document.createElement('button');
  exportBtn.className = 'modal-btn';
  exportBtn.type = 'button';
  exportBtn.textContent = t('groups.export');
  exportBtn.addEventListener('click', () => exportGroup(group));

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'modal-btn modal-btn-danger';
  deleteBtn.type = 'button';
  deleteBtn.textContent = t('groups.delete');
  deleteBtn.addEventListener('click', () => deleteGroup(group));

  bar.appendChild(installBtn);
  bar.appendChild(editBtn);
  bar.appendChild(exportBtn);
  bar.appendChild(deleteBtn);
  cardsGrid.appendChild(bar);

  const term = searchInput.value.trim().toLowerCase();
  const items = getGroupSoftware(group)
    .filter(sw => !term || sw.name.toLowerCase().includes(term));

  if (items.length === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'empty-state';
    emptyDiv.innerHTML = `
      <div class="empty-state-icon">\u{1F4E6}</div>
      <div class="empty-state-title">${t('empty.title')}</div>
      <div class="empty-state-description">${t('groups.empty')}.</div>
    `;
    cardsGrid.appendChild(emptyDiv);
    return;
  }

  items.forEach(sw => cardsGrid.appendChild(createCardElement(sw, null)));
}

// ----- Group create/edit modal -----

let editingGroup = null;
let modalSelection = new Set();

function setupGroupModal() {
  newGroupBtn.addEventListener('click', () => openGroupModal(null));
  importGroupBtn.addEventListener('click', importGroups);
  groupCancelBtn.addEventListener('click', closeGroupModal);
  groupSaveBtn.addEventListener('click', saveGroupModal);
  groupSearchInput.addEventListener('input', renderModalList);
  groupModal.addEventListener('click', (e) => {
    if (e.target === groupModal) closeGroupModal();
  });
}

function openGroupModal(group) {
  editingGroup = group;
  modalSelection = new Set(group ? group.softwareIds : []);
  groupModalTitle.textContent = group ? t('groups.edit') : t('groups.new');
  groupNameInput.value = group ? group.name : '';
  groupNameInput.placeholder = t('groups.namePlaceholder');
  groupSearchInput.value = '';
  groupSearchInput.placeholder = t('groups.searchPlaceholder');
  groupSaveBtn.textContent = t('groups.save');
  groupCancelBtn.textContent = t('groups.cancel');
  renderModalList();
  groupModal.hidden = false;
  groupNameInput.focus();
}

function closeGroupModal() {
  groupModal.hidden = true;
  editingGroup = null;
}

function renderModalList() {
  const term = groupSearchInput.value.trim().toLowerCase();
  groupSoftwareList.innerHTML = '';

  for (const cat of categories) {
    const list = (softwareData[cat.id] || [])
      .filter(sw => !term || sw.name.toLowerCase().includes(term));
    if (!list.length) continue;

    const header = document.createElement('div');
    header.className = 'modal-cat';
    header.textContent = currentLang === 'en' ? (cat.name_en || cat.name) : cat.name;
    groupSoftwareList.appendChild(header);

    for (const sw of list) {
      const row = document.createElement('label');
      row.className = 'modal-row';
      if (installedStatus[sw.id] === true) row.classList.add('installed');
      row.title = installedStatus[sw.id] === true ? t('toast.alreadyInstalled') : '';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = modalSelection.has(sw.id);
      cb.addEventListener('change', () => {
        if (cb.checked) modalSelection.add(sw.id);
        else modalSelection.delete(sw.id);
        updateModalCount();
      });

      const nameSpan = document.createElement('span');
      nameSpan.textContent = sw.name;

      row.appendChild(cb);
      row.appendChild(nameSpan);
      groupSoftwareList.appendChild(row);
    }
  }
  updateModalCount();
}

function updateModalCount() {
  groupSelectedCount.textContent = `${modalSelection.size} ${t('groups.selected')}`;
}

async function saveGroupModal() {
  const name = groupNameInput.value.trim();
  if (!name) {
    showToast(t('groups.nameRequired'), 'warning');
    return;
  }
  const payload = { name, softwareIds: [...modalSelection] };
  if (editingGroup) payload.id = editingGroup.id;

  try {
    const saved = await window.electronAPI.groups.save(payload);
    const idx = groups.findIndex(g => g.id === saved.id);
    if (idx >= 0) groups[idx] = saved;
    else groups.push(saved);
    closeGroupModal();
    renderGroupsNav();
    selectGroup(saved.id);
  } catch (err) {
    showToast(`${t('toast.error')}${err.message}`, 'error');
  }
}

async function deleteGroup(group) {
  if (!confirm(`${t('groups.deleteConfirm')} "${group.name}"?`)) return;
  await window.electronAPI.groups.delete(group.id);
  groups = groups.filter(g => g.id !== group.id);
  renderGroupsNav();
  if (categories.length > 0) selectCategory(categories[0].id);
}

async function exportGroup(group) {
  try {
    const result = await window.electronAPI.groups.export(group);
    if (!result.canceled) showToast(t('groups.exportDone'), 'success');
  } catch (err) {
    showToast(`${t('toast.error')}${err.message}`, 'error');
  }
}

async function importGroups() {
  try {
    const result = await window.electronAPI.groups.import();
    if (result.canceled) return;
    if (!result.imported || result.imported.length === 0) {
      showToast(t('groups.importNone'), 'warning');
      return;
    }
    groups.push(...result.imported);
    renderGroupsNav();
    showToast(`${result.imported.length} ${t('groups.importDone')}`, 'success');
    selectGroup(result.imported[0].id);
  } catch (err) {
    showToast(`${t('groups.importError')}${err.message}`, 'error');
  }
}

// ============================================================
// Install Queue Panel
// ============================================================

function setupQueuePanel() {
  queueCloseBtn.addEventListener('click', () => {
    queuePanel.hidden = true;
  });

  queueCancelBtn.addEventListener('click', async () => {
    if (window.electronAPI && window.electronAPI.queue) {
      await window.electronAPI.queue.cancel();
      queueCancelBtn.disabled = true;
    }
  });

  if (window.electronAPI && window.electronAPI.queue) {
    window.electronAPI.queue.onUpdate((data) => {
      if (data.id === '__queue__') {
        queueActive = false;
        queueCancelBtn.disabled = true;
        showToast(t('queue.done'), 'success');
        return;
      }
      const row = queueItems.querySelector(`.queue-row[data-id="${data.id}"]`);
      if (!row) return;
      row.dataset.state = data.state;
      row.querySelector('.queue-status').textContent = t('queue.state.' + data.state);
    });
  }
}

async function startQueue(group) {
  if (queueActive) {
    showToast(t('queue.alreadyRunning'), 'warning');
    return;
  }
  const items = getGroupSoftware(group).filter(sw => installedStatus[sw.id] !== true);
  if (!items.length) {
    showToast(t('queue.empty'), 'info');
    return;
  }

  queueActive = true;
  queueCancelBtn.disabled = false;
  queueCancelBtn.textContent = t('queue.cancel');
  document.getElementById('queue-title').textContent = `${t('queue.title')}: ${group.name}`;
  queueItems.innerHTML = '';

  items.forEach(sw => {
    const row = document.createElement('div');
    row.className = 'queue-row';
    row.dataset.id = sw.id;
    row.dataset.state = 'queued';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'queue-name';
    nameSpan.textContent = sw.name;

    const statusSpan = document.createElement('span');
    statusSpan.className = 'queue-status';
    statusSpan.textContent = t('queue.state.queued');

    row.appendChild(nameSpan);
    row.appendChild(statusSpan);
    queueItems.appendChild(row);
  });

  queuePanel.hidden = false;

  try {
    await window.electronAPI.queue.start('q' + Date.now(), items);
  } catch (err) {
    queueActive = false;
    showToast(`${t('toast.error')}${err.message}`, 'error');
  }
}

// ============================================================
// Utility
// ============================================================

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ============================================================
// Start
// ============================================================

document.addEventListener('DOMContentLoaded', init);
