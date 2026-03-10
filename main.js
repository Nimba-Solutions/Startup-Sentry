/**
 * @name         Startup Sentry
 * @license      BSL 1.1 — See LICENSE.md
 * @description  Main process — manages window, tray, IPC, and startup item operations via PowerShell
 * @author       Cloud Nimbus LLC
 */

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, dialog } = require('electron');
const path = require('path');
const { execSync, exec } = require('child_process');
const fs = require('fs');
const Store = require('electron-store');

const store = new Store({
  defaults: {
    startMinimized: false,
    showHKLM: false,
    disabledItems: []
  }
});

let mainWindow = null;
let tray = null;
let isAdmin = false;

/* ── Admin check ─────────────────────────────────────────────── */

function checkAdmin() {
  try {
    execSync('net session', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/* ── Tray icon (emerald "SS") ────────────────────────────────── */

function createTrayIcon() {
  const size = 32;
  const canvas = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <rect width="${size}" height="${size}" rx="6" fill="#059669"/>
      <text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle"
            font-family="Segoe UI,sans-serif" font-weight="700" font-size="16" fill="#fff">SS</text>
    </svg>`;
  // Electron nativeImage can't parse SVG directly; create a 32x32 data-url PNG via a tiny canvas trick.
  // Instead, we'll draw with nativeImage.createFromBuffer by building a raw RGBA buffer.
  const img = nativeImage.createEmpty();
  // Fallback: build a simple 16x16 green square icon
  const buf = Buffer.alloc(16 * 16 * 4);
  for (let i = 0; i < 16 * 16; i++) {
    buf[i * 4 + 0] = 5;    // R
    buf[i * 4 + 1] = 150;  // G
    buf[i * 4 + 2] = 105;  // B
    buf[i * 4 + 3] = 255;  // A
  }
  return nativeImage.createFromBuffer(buf, { width: 16, height: 16 });
}

/* ── Window ──────────────────────────────────────────────────── */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 700,
    minWidth: 700,
    minHeight: 500,
    show: false,
    backgroundColor: '#0f1a14',
    title: 'Startup Sentry',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    if (!store.get('startMinimized')) mainWindow.show();
  });

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

/* ── Tray ────────────────────────────────────────────────────── */

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('Startup Sentry');
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show', click: () => mainWindow && mainWindow.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => mainWindow && mainWindow.show());
}

/* ── PowerShell helpers ──────────────────────────────────────── */

function ps(script) {
  return new Promise((resolve, reject) => {
    exec(
      `powershell -NoProfile -NonInteractive -Command "${script.replace(/"/g, '\\"')}"`,
      { maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve(stdout.trim());
      }
    );
  });
}

function psSync(script) {
  try {
    return execSync(
      `powershell -NoProfile -NonInteractive -Command "${script.replace(/"/g, '\\"')}"`,
      { maxBuffer: 10 * 1024 * 1024 }
    ).toString().trim();
  } catch (e) {
    return '';
  }
}

/* ── Get startup items ───────────────────────────────────────── */

async function getStartupItems() {
  const items = [];
  const disabledItems = store.get('disabledItems') || [];

  // 1. HKCU\...\Run
  try {
    const hkcuScript = `
      $items = @()
      try {
        $key = Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue
        if ($key) {
          $key.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object {
            $items += [PSCustomObject]@{ Name = $_.Name; Command = $_.Value }
          }
        }
      } catch {}
      $items | ConvertTo-Json -Compress
    `;
    const raw = await ps(hkcuScript);
    if (raw && raw !== '') {
      const parsed = JSON.parse(raw.startsWith('[') ? raw : '[' + raw + ']');
      parsed.forEach(p => {
        if (p.Name && !p.Name.startsWith('(')) {
          items.push({
            id: 'hkcu_' + p.Name,
            name: p.Name,
            command: p.Command || '',
            source: 'Registry (HKCU)',
            enabled: true,
            type: 'hkcu'
          });
        }
      });
    }
  } catch { /* ignore */ }

  // 2. HKLM\...\Run (admin only)
  if (isAdmin && store.get('showHKLM')) {
    try {
      const hklmScript = `
        $items = @()
        try {
          $key = Get-ItemProperty -Path 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue
          if ($key) {
            $key.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object {
              $items += [PSCustomObject]@{ Name = $_.Name; Command = $_.Value }
            }
          }
        } catch {}
        $items | ConvertTo-Json -Compress
      `;
      const raw = await ps(hklmScript);
      if (raw && raw !== '') {
        const parsed = JSON.parse(raw.startsWith('[') ? raw : '[' + raw + ']');
        parsed.forEach(p => {
          if (p.Name && !p.Name.startsWith('(')) {
            items.push({
              id: 'hklm_' + p.Name,
              name: p.Name,
              command: p.Command || '',
              source: 'Registry (HKLM)',
              enabled: true,
              type: 'hklm'
            });
          }
        });
      }
    } catch { /* ignore */ }
  }

  // 3. Startup folder
  try {
    const folderScript = `
      $folder = [Environment]::GetFolderPath('Startup')
      $items = @()
      Get-ChildItem -Path $folder -File -ErrorAction SilentlyContinue | ForEach-Object {
        $items += [PSCustomObject]@{
          Name = $_.BaseName
          Command = $_.FullName
          Extension = $_.Extension
        }
      }
      $items | ConvertTo-Json -Compress
    `;
    const raw = await ps(folderScript);
    if (raw && raw !== '') {
      const parsed = JSON.parse(raw.startsWith('[') ? raw : '[' + raw + ']');
      parsed.forEach(p => {
        if (p.Name) {
          items.push({
            id: 'folder_' + p.Name,
            name: p.Name,
            command: p.Command || '',
            source: 'Startup Folder',
            enabled: true,
            type: 'folder'
          });
        }
      });
    }
  } catch { /* ignore */ }

  // 4. Scheduled tasks (best effort)
  try {
    const taskScript = `
      $items = @()
      Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
        $_.Settings.StartWhenAvailable -eq $true -or
        ($_.Triggers | Where-Object { $_ -is [CimInstance] -and $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' })
      } | Select-Object -First 30 | ForEach-Object {
        $action = ($_.Actions | Select-Object -First 1).Execute
        $items += [PSCustomObject]@{
          Name = $_.TaskName
          Command = $action
          State = $_.State.ToString()
        }
      }
      $items | ConvertTo-Json -Compress
    `;
    const raw = await ps(taskScript);
    if (raw && raw !== '') {
      const parsed = JSON.parse(raw.startsWith('[') ? raw : '[' + raw + ']');
      parsed.forEach(p => {
        if (p.Name && p.Command) {
          items.push({
            id: 'task_' + p.Name,
            name: p.Name,
            command: p.Command || '',
            source: 'Scheduled Task',
            enabled: p.State === 'Ready' || p.State === 'Running',
            type: 'task'
          });
        }
      });
    }
  } catch { /* ignore */ }

  // Enrich with file info
  for (const item of items) {
    const exePath = extractExePath(item.command);
    if (exePath) {
      try {
        const infoScript = `
          $p = '${exePath.replace(/'/g, "''")}'
          if (Test-Path $p) {
            $f = Get-Item $p
            $vi = $f.VersionInfo
            [PSCustomObject]@{
              Size = $f.Length
              Publisher = $vi.CompanyName
            } | ConvertTo-Json -Compress
          }
        `;
        const raw = await ps(infoScript);
        if (raw) {
          const info = JSON.parse(raw);
          item.fileSize = info.Size || null;
          item.publisher = info.Publisher || null;
        }
      } catch { /* ignore */ }
    }
  }

  // Mark disabled items
  disabledItems.forEach(d => {
    const existing = items.find(i => i.id === d.id);
    if (!existing) {
      items.push({ ...d, enabled: false });
    }
  });

  return items;
}

function extractExePath(cmd) {
  if (!cmd) return null;
  // Remove quotes
  let p = cmd.replace(/^["']|["']$/g, '');
  // Take first token if it has arguments
  const match = p.match(/^"([^"]+)"|^(\S+)/);
  if (match) p = match[1] || match[2];
  // Strip arguments after .exe
  const exeIdx = p.toLowerCase().indexOf('.exe');
  if (exeIdx > -1) p = p.substring(0, exeIdx + 4);
  return p;
}

/* ── Enable / Disable ────────────────────────────────────────── */

async function disableItem(item) {
  const disabledItems = store.get('disabledItems') || [];

  if (item.type === 'hkcu') {
    await ps(`Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name '${item.name.replace(/'/g, "''")}' -ErrorAction SilentlyContinue`);
  } else if (item.type === 'hklm' && isAdmin) {
    await ps(`Remove-ItemProperty -Path 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name '${item.name.replace(/'/g, "''")}' -ErrorAction SilentlyContinue`);
  } else if (item.type === 'folder') {
    const folderPath = psSync(`[Environment]::GetFolderPath('Startup')`);
    const filePath = item.command;
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const disabledName = 'disabled_' + base;
    try {
      fs.renameSync(path.join(dir, base), path.join(dir, disabledName));
      item.command = path.join(dir, disabledName);
    } catch { /* ignore */ }
  } else if (item.type === 'task') {
    await ps(`Disable-ScheduledTask -TaskName '${item.name.replace(/'/g, "''")}' -ErrorAction SilentlyContinue`);
  }

  item.enabled = false;
  // Track in store
  const exists = disabledItems.find(d => d.id === item.id);
  if (!exists) disabledItems.push(item);
  store.set('disabledItems', disabledItems);
}

async function enableItem(item) {
  const disabledItems = store.get('disabledItems') || [];

  if (item.type === 'hkcu') {
    await ps(`Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name '${item.name.replace(/'/g, "''")}' -Value '${item.command.replace(/'/g, "''")}'`);
  } else if (item.type === 'hklm' && isAdmin) {
    await ps(`Set-ItemProperty -Path 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name '${item.name.replace(/'/g, "''")}' -Value '${item.command.replace(/'/g, "''")}'`);
  } else if (item.type === 'folder') {
    const filePath = item.command;
    if (filePath && filePath.includes('disabled_')) {
      const dir = path.dirname(filePath);
      const base = path.basename(filePath);
      const enabledName = base.replace(/^disabled_/, '');
      try {
        fs.renameSync(path.join(dir, base), path.join(dir, enabledName));
        item.command = path.join(dir, enabledName);
      } catch { /* ignore */ }
    }
  } else if (item.type === 'task') {
    await ps(`Enable-ScheduledTask -TaskName '${item.name.replace(/'/g, "''")}' -ErrorAction SilentlyContinue`);
  }

  // Remove from disabled tracking
  store.set('disabledItems', disabledItems.filter(d => d.id !== item.id));
}

/* ── Add / Remove ────────────────────────────────────────────── */

async function addItem(name, command) {
  // Add to HKCU Run
  await ps(`Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name '${name.replace(/'/g, "''")}' -Value '${command.replace(/'/g, "''")}'`);
}

async function removeItem(item) {
  if (item.type === 'hkcu') {
    await ps(`Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name '${item.name.replace(/'/g, "''")}' -ErrorAction SilentlyContinue`);
  } else if (item.type === 'hklm' && isAdmin) {
    await ps(`Remove-ItemProperty -Path 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name '${item.name.replace(/'/g, "''")}' -ErrorAction SilentlyContinue`);
  } else if (item.type === 'folder') {
    try { fs.unlinkSync(item.command); } catch { /* ignore */ }
  } else if (item.type === 'task') {
    await ps(`Unregister-ScheduledTask -TaskName '${item.name.replace(/'/g, "''")}' -Confirm:$false -ErrorAction SilentlyContinue`);
  }

  // Also remove from disabled tracking
  const disabledItems = store.get('disabledItems') || [];
  store.set('disabledItems', disabledItems.filter(d => d.id !== item.id));
}

/* ── Open file location ──────────────────────────────────────── */

function openLocation(command) {
  const exePath = extractExePath(command);
  if (exePath && fs.existsSync(exePath)) {
    shell.showItemInFolder(exePath);
  } else if (command) {
    // Try opening the raw path
    const raw = command.replace(/^["']|["']$/g, '').split(' ')[0];
    if (fs.existsSync(raw)) {
      shell.showItemInFolder(raw);
    }
  }
}

/* ── Self-elevate ────────────────────────────────────────────── */

function selfElevate() {
  const appPath = app.getPath('exe');
  exec(`powershell -Command "Start-Process '${appPath}' -Verb RunAs"`, () => {
    app.isQuitting = true;
    app.quit();
  });
}

/* ── IPC handlers ────────────────────────────────────────────── */

function registerIPC() {
  ipcMain.handle('get-startup-items', async () => {
    try {
      return await getStartupItems();
    } catch (e) {
      return [];
    }
  });

  ipcMain.handle('enable-item', async (_e, item) => {
    await enableItem(item);
    return true;
  });

  ipcMain.handle('disable-item', async (_e, item) => {
    await disableItem(item);
    return true;
  });

  ipcMain.handle('add-item', async (_e, name, command) => {
    await addItem(name, command);
    return true;
  });

  ipcMain.handle('remove-item', async (_e, item) => {
    await removeItem(item);
    return true;
  });

  ipcMain.handle('open-location', (_e, command) => {
    openLocation(command);
    return true;
  });

  ipcMain.handle('get-settings', () => {
    return {
      startMinimized: store.get('startMinimized'),
      showHKLM: store.get('showHKLM')
    };
  });

  ipcMain.handle('save-settings', (_e, settings) => {
    if (settings.startMinimized !== undefined) store.set('startMinimized', settings.startMinimized);
    if (settings.showHKLM !== undefined) store.set('showHKLM', settings.showHKLM);
    return true;
  });

  ipcMain.handle('check-admin', () => isAdmin);

  ipcMain.handle('self-elevate', () => {
    selfElevate();
    return true;
  });
}

/* ── App lifecycle ───────────────────────────────────────────── */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    isAdmin = checkAdmin();
    registerIPC();
    createWindow();
    createTray();
  });
}

app.on('window-all-closed', (e) => {
  // Prevent quit, keep tray alive
});

app.on('before-quit', () => {
  app.isQuitting = true;
});
