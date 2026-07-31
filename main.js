const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const { autoUpdater } = require('electron-updater');

const GITHUB_REPO = 'spadieri/software-loadout';

function getWgetPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'wget.exe');
  }
  return path.join(__dirname, 'resources', 'wget.exe');
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    titleBarStyle: 'default',
    backgroundColor: '#1e1e2e'
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();
  // Kick off registry + Appx scan in parallel with window load
  // so by the time the renderer asks, it's often already ready.
  startInstalledScan();
  if (app.isPackaged) {
    setTimeout(checkForUpdates, 3000);
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

// ============================================================
// Auto-update: event-driven header badge (no modal dialogs)
// NSIS flavor: download + install in-app. Portable flavor: external link.
// ============================================================

const updateState = {
  flavor: null,       // 'nsis' | 'portable' | null
  version: null,      // '1.3.1'
  htmlUrl: null,      // release page (portable only)
  downloading: false, // true while autoUpdater is downloading
  progress: 0,        // 0..100
  downloaded: false   // true when ready to install
};

function sendUpdateState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:state', updateState);
  }
}

function isPortable() {
  return !!process.env.PORTABLE_EXECUTABLE_DIR;
}

function isNewerVersion(remote, current) {
  const r = remote.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const c = current.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((r[i] || 0) > (c[i] || 0)) return true;
    if ((r[i] || 0) < (c[i] || 0)) return false;
  }
  return false;
}

function checkForUpdates() {
  if (isPortable()) {
    checkForUpdatesPortable();
  } else {
    setupNsisAutoUpdater();
  }
}

function checkForUpdatesPortable() {
  const req = https.get(
    `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
    { headers: { 'User-Agent': 'SoftwareLoadout-Updater', 'Accept': 'application/vnd.github+json' } },
    (res) => {
      if (res.statusCode !== 200) { res.resume(); return; }
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const release = JSON.parse(data);
          if (!release.tag_name) return;
          if (!isNewerVersion(release.tag_name, app.getVersion())) return;

          updateState.flavor = 'portable';
          updateState.version = release.tag_name.replace(/^v/, '');
          updateState.htmlUrl = release.html_url;
          sendUpdateState();
        } catch (err) {
          console.error('Update check failed:', err);
        }
      });
    }
  );
  req.on('error', (err) => console.error('Update check error:', err));
  req.setTimeout(5000, () => req.destroy());
}

function setupNsisAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    updateState.flavor = 'nsis';
    updateState.version = info.version;
    sendUpdateState();
  });

  autoUpdater.on('download-progress', (p) => {
    updateState.progress = Math.round(p.percent || 0);
    sendUpdateState();
  });

  autoUpdater.on('update-downloaded', (info) => {
    updateState.downloading = false;
    updateState.downloaded = true;
    updateState.progress = 100;
    updateState.version = info.version;
    sendUpdateState();
  });

  autoUpdater.on('error', (err) => {
    console.error('Auto-updater error:', err);
    updateState.downloading = false;
    sendUpdateState();
  });

  autoUpdater.checkForUpdates().catch((err) => {
    console.error('checkForUpdates failed:', err);
  });
}

ipcMain.handle('update:get-state', () => updateState);

ipcMain.handle('update:start-download', async () => {
  if (updateState.flavor !== 'nsis') return;
  if (updateState.downloading || updateState.downloaded) return;
  updateState.downloading = true;
  updateState.progress = 0;
  sendUpdateState();
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    console.error('downloadUpdate failed:', err);
    updateState.downloading = false;
    sendUpdateState();
  }
});

ipcMain.handle('update:quit-and-install', () => {
  if (!updateState.downloaded) return;
  autoUpdater.quitAndInstall();
});

ipcMain.handle('update:open-external', () => {
  if (updateState.htmlUrl) shell.openExternal(updateState.htmlUrl);
});

// ============================================================
// Task 6: Registry Detection - Check which software is installed
// ============================================================

function getRegistryInstalledNames() {
  const names = [];
  const registryKeys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
  ];

  for (const key of registryKeys) {
    try {
      const output = execSync(
        `reg query "${key}" /s /v DisplayName 2>nul`,
        { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 15000 }
      );
      const matches = output.match(/DisplayName\s+REG_SZ\s+(.+)/gi);
      if (matches) {
        for (const match of matches) {
          const name = match.replace(/DisplayName\s+REG_SZ\s+/i, '').trim();
          if (name) names.push(name.toLowerCase());
        }
      }
    } catch {
      // Registry key may not exist, ignore
    }
  }

  return names;
}

// Cached list of MSIX/Appx package names (Start Menu apps, Store apps, Electron
// apps using Squirrel-over-MSIX like Claude Desktop). Get-AppxPackage is slow
// (~1-2s) so we cache for the session.
let appxNamesCache = null;
function getAppxInstalledNames() {
  if (appxNamesCache !== null) return appxNamesCache;
  try {
    const output = execSync(
      'powershell -NoProfile -Command "Get-AppxPackage | ForEach-Object { $_.Name }"',
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 20000 }
    );
    appxNamesCache = output
      .split(/\r?\n/)
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
  } catch (err) {
    console.error('Get-AppxPackage failed:', err.message);
    appxNamesCache = [];
  }
  return appxNamesCache;
}

// In-flight scan: started at app-ready, so by the time the renderer asks,
// it's often already done and check-installed returns instantly.
let installedNamesPromise = null;
function startInstalledScan() {
  if (installedNamesPromise) return installedNamesPromise;
  installedNamesPromise = new Promise((resolve) => {
    setImmediate(() => {
      try {
        const names = [
          ...getRegistryInstalledNames(),
          ...getAppxInstalledNames()
        ];
        resolve(names);
      } catch (err) {
        console.error('Installed scan failed:', err);
        resolve([]);
      }
    });
  });
  return installedNamesPromise;
}

function installedCachePath() {
  return path.join(app.getPath('userData'), 'installed-cache.json');
}

function writeInstalledCache(installedMap) {
  try {
    fs.writeFileSync(installedCachePath(), JSON.stringify({
      timestamp: Date.now(),
      installed: installedMap
    }));
  } catch (err) {
    console.error('Failed to write installed cache:', err);
  }
}

function readInstalledCache() {
  try {
    const raw = fs.readFileSync(installedCachePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed.installed || {};
  } catch {
    return {};
  }
}

ipcMain.handle('get-cached-installed', () => readInstalledCache());

// User-triggered refresh: invalidate the in-memory caches so the next
// check-installed forces a fresh scan. Returns when the scan is complete.
ipcMain.handle('refresh-installed', async () => {
  installedNamesPromise = null;
  appxNamesCache = null;
  await startInstalledScan();
  return true;
});

ipcMain.handle('check-installed', async (_event, softwareList) => {
  const installed = {};

  try {
    const installedNames = await startInstalledScan();

    for (const software of softwareList) {
      const regMatch = software.detectRegistry?.some(name =>
        installedNames.some(n => n.includes(name.toLowerCase()))
      ) || false;

      const pathMatch = software.detectPaths?.some(p => {
        const resolved = p.replace(/%USERNAME%/g, process.env.USERNAME || '');
        return fs.existsSync(resolved);
      }) || false;

      installed[software.id] = regMatch || pathMatch;
    }

    // Persist so the next app start can render badges from the first frame.
    // Only overwrite when the list is meaningfully large (i.e. the renderer
    // sent the full catalog) — avoids small per-category calls corrupting cache.
    if (softwareList.length >= 50) {
      const existing = readInstalledCache();
      writeInstalledCache({ ...existing, ...installed });
    }
  } catch (err) {
    console.error('check-installed failed:', err);
  }

  return installed;
});

// ============================================================
// Download URL resolver - supports GitHub API (auto-latest) or static URL
// ============================================================

const urlCache = new Map();
const URL_CACHE_TTL_MS = 60 * 60 * 1000;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'SoftwareLoadout',
          'Accept': 'application/vnd.github+json'
        }
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} ${url}`));
          return;
        }
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (err) { reject(err); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('GitHub API timeout')));
  });
}

async function resolveDownloadUrl(software) {
  if (software.source !== 'github') {
    return software.downloadUrl;
  }

  const cached = urlCache.get(software.id);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.url;
  }

  const release = await fetchJson(
    `https://api.github.com/repos/${software.repo}/releases/latest`
  );
  const pattern = new RegExp(software.assetPattern);
  const asset = (release.assets || []).find((a) => pattern.test(a.name));
  if (!asset) {
    throw new Error(
      `No asset matches /${software.assetPattern}/ in ${software.repo}@${release.tag_name}`
    );
  }

  urlCache.set(software.id, {
    url: asset.browser_download_url,
    expiresAt: Date.now() + URL_CACHE_TTL_MS
  });
  return asset.browser_download_url;
}

// ============================================================
// Task 7: Download Engine - wget download + auto-launch installer
// ============================================================

// Core download routine shared by the single-download handler and the
// install queue. Resolves the URL (static or GitHub), downloads via wget
// to ~/Downloads/SoftwareLoadout and reports progress. Does NOT launch
// anything — callers decide what to do with the file.
function downloadToDisk(software) {
  return new Promise((resolve, reject) => {
    const downloadsPath = path.join(app.getPath('downloads'), 'SoftwareLoadout');

    if (!fs.existsSync(downloadsPath)) {
      fs.mkdirSync(downloadsPath, { recursive: true });
    }

    const outputPath = path.join(downloadsPath, software.filename);
    const wgetPath = getWgetPath();

    resolveDownloadUrl(software).then((downloadUrl) => {
      const args = [
        downloadUrl,
        '-O', outputPath,
        '--no-check-certificate',
        '-q', '--show-progress'
      ];

      const proc = spawn(wgetPath, args);
      if (activeQueue) activeQueue.wgetProc = proc;

      proc.stderr.on('data', (data) => {
        const output = data.toString();
        const match = output.match(/(\d+)%/);
        if (match && mainWindow) {
          mainWindow.webContents.send('download-progress', {
            id: software.id,
            progress: parseInt(match[1])
          });
        }
      });

      proc.on('close', (code) => {
        if (code === 0 && fs.existsSync(outputPath)) {
          resolve(outputPath);
        } else {
          // Clean up partial download
          try { fs.unlinkSync(outputPath); } catch {}
          reject(new Error(`Download failed (exit code ${code})`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to start wget: ${err.message}`));
      });
    }).catch(reject);
  });
}

ipcMain.handle('download-software', async (_event, software) => {
  const outputPath = await downloadToDisk(software);
  // Auto-launch the installer (triggers UAC for .exe/.msi)
  shell.openPath(outputPath).then((error) => {
    if (error) {
      console.error('Failed to launch installer:', error);
    }
  });
  return { success: true, path: outputPath };
});

// ============================================================
// Custom groups (user "loadouts") - stored in %AppData%/groups.json
// ============================================================

function groupsPath() {
  return path.join(app.getPath('userData'), 'groups.json');
}

function readGroups() {
  try {
    const parsed = JSON.parse(fs.readFileSync(groupsPath(), 'utf8'));
    return Array.isArray(parsed.groups) ? parsed.groups : [];
  } catch {
    return [];
  }
}

function writeGroups(groups) {
  try {
    fs.writeFileSync(groupsPath(), JSON.stringify({ groups }, null, 2));
  } catch (err) {
    console.error('Failed to write groups:', err);
  }
}

ipcMain.handle('groups:get-all', () => readGroups());

ipcMain.handle('groups:save', (_event, group) => {
  const groups = readGroups();
  const name = String(group.name || '').trim();
  const softwareIds = Array.isArray(group.softwareIds)
    ? group.softwareIds.filter(id => typeof id === 'string')
    : [];

  if (group.id) {
    const i = groups.findIndex(g => g.id === group.id);
    if (i >= 0) {
      groups[i] = { ...groups[i], name, softwareIds };
      writeGroups(groups);
      return groups[i];
    }
  }

  const created = { id: crypto.randomUUID(), name, softwareIds, createdAt: Date.now() };
  groups.push(created);
  writeGroups(groups);
  return created;
});

ipcMain.handle('groups:delete', (_event, id) => {
  writeGroups(readGroups().filter(g => g.id !== id));
  return true;
});

// ============================================================
// Install queue - serial setup execution with download-ahead-1
// One installer at a time (spawn + wait for exit); the next download
// runs in the background while the current setup is open.
// ============================================================

let activeQueue = null; // { queueId, cancelRequested, wgetProc }

function sendQueue(itemId, state, extra = {}) {
  if (activeQueue && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('queue:item-state', {
      queueId: activeQueue.queueId,
      id: itemId,
      state,
      ...extra
    });
  }
}

function launchInstallerAndWait(filePath) {
  return new Promise((resolve) => {
    let proc;
    try {
      if (/\.msi$/i.test(filePath)) {
        proc = spawn('msiexec', ['/i', filePath]);
      } else {
        proc = spawn(filePath, []);
      }
    } catch {
      resolve();
      return;
    }
    const done = () => resolve();
    proc.on('error', done);
    proc.on('exit', done);
  });
}

ipcMain.handle('queue:start', (_event, payload) => {
  const { queueId, items } = payload || {};
  if (activeQueue) throw new Error('Queue already running');
  if (!Array.isArray(items) || !items.length) throw new Error('Empty queue');

  activeQueue = { queueId, cancelRequested: false, wgetProc: null };

  (async () => {
    let preStarted = null; // { sw, promise }

    // Pre-start the download of the next downloadable item, marking
    // browser-source entries as skipped along the way.
    const startNext = (fromIdx) => {
      preStarted = null;
      for (let j = fromIdx; j < items.length; j++) {
        const sw = items[j];
        if (sw.source === 'browser') {
          sendQueue(sw.id, 'skipped-browser');
          continue;
        }
        sendQueue(sw.id, 'downloading');
        preStarted = {
          sw,
          promise: downloadToDisk(sw)
            .then(p => ({ ok: true, path: p }))
            .catch(e => ({ ok: false, error: e }))
        };
        return;
      }
    };

    startNext(0);

    for (let i = 0; i < items.length; i++) {
      const sw = items[i];
      if (sw.source === 'browser') continue; // already marked by startNext

      if (activeQueue.cancelRequested) {
        sendQueue(sw.id, 'cancelled');
        continue;
      }

      // Consume the pre-started download (fallback: download now)
      let dl;
      if (preStarted && preStarted.sw.id === sw.id) {
        dl = await preStarted.promise;
      } else {
        sendQueue(sw.id, 'downloading');
        dl = await downloadToDisk(sw)
          .then(p => ({ ok: true, path: p }))
          .catch(e => ({ ok: false, error: e }));
      }

      if (!dl.ok) {
        sendQueue(sw.id, 'error', { message: String((dl.error && dl.error.message) || dl.error) });
        startNext(i + 1);
        continue;
      }

      // Download-ahead-1: fetch the next item while this setup runs
      startNext(i + 1);

      if (!/\.(exe|msi)$/i.test(dl.path)) {
        // Archives (zip/7z/msixbundle) can't be auto-installed
        sendQueue(sw.id, 'downloaded-only', { path: dl.path });
        continue;
      }

      sendQueue(sw.id, 'installing');
      await launchInstallerAndWait(dl.path);
      sendQueue(sw.id, 'done');
    }

    sendQueue('__queue__', 'queue-finished');
    activeQueue = null;
  })();

  return { started: true };
});

ipcMain.handle('queue:cancel', () => {
  if (!activeQueue) return false;
  activeQueue.cancelRequested = true;
  try { if (activeQueue.wgetProc) activeQueue.wgetProc.kill(); } catch {}
  return true;
});

ipcMain.handle('get-downloads-path', () => {
  return path.join(app.getPath('downloads'), 'SoftwareLoadout');
});

ipcMain.handle('open-downloads-folder', () => {
  const downloadsPath = path.join(app.getPath('downloads'), 'SoftwareLoadout');
  if (!fs.existsSync(downloadsPath)) {
    fs.mkdirSync(downloadsPath, { recursive: true });
  }
  shell.openPath(downloadsPath);
});

ipcMain.handle('open-external', (_event, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    shell.openExternal(url);
  }
});
