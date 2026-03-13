/**
 * @name         Startup Sentry
 * @license      BSL 1.1 — See LICENSE.md
 * @description  Main process — manages window, tray, IPC, and startup item operations (cross-platform)
 * @author       Cloud Nimbus LLC
 */

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, dialog } = require('electron');
const path = require('path');
const os = require('os');
const { execSync, exec } = require('child_process');
const guard = require('./process-guard');
const fs = require('fs');
const Store = require('electron-store');

const platform = process.platform; // 'win32', 'darwin', 'linux'

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

/* ── Input sanitization ──────────────────────────────────────── */

function sanitizeShellArg(str) {
  if (!str) return '';
  // Remove null bytes and escape single quotes for shell usage
  return str.replace(/\0/g, '').replace(/'/g, "'\\''");
}

/* ── Admin check ─────────────────────────────────────────────── */

function checkAdmin() {
  try {
    if (platform === 'win32') {
      execSync('net session', { stdio: 'ignore' });
      return true;
    } else if (platform === 'darwin') {
      const result = execSync('id -Gn', { encoding: 'utf8' }).trim();
      return result.split(/\s+/).includes('admin');
    } else {
      // Linux: check if root or if user has sudo access
      const uid = execSync('id -u', { encoding: 'utf8' }).trim();
      return uid === '0';
    }
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

/* ── PowerShell helpers (Windows) ────────────────────────────── */

function ps(script) {
  const cmd = `powershell -NoProfile -NonInteractive -Command "${script.replace(/"/g, '\\"')}"`;
  return guard.execPromise(cmd).then(s => (s || '').trim());
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

/* ── Shell helper (macOS/Linux) ──────────────────────────────── */

function runShell(command) {
  return guard.execPromise(command).then(s => (s || '').trim());
}

function runShellSync(command) {
  try {
    return execSync(command, {
      shell: '/bin/bash',
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf8'
    }).trim();
  } catch (e) {
    return '';
  }
}

/* ── macOS plist parsing helper ──────────────────────────────── */

function parsePlist(filePath) {
  try {
    const json = runShellSync(`plutil -convert json -o - '${sanitizeShellArg(filePath)}'`);
    if (!json) return null;
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/* ── Linux .desktop file parsing helper ──────────────────────── */

function parseDesktopFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const result = { Name: '', Exec: '', Hidden: false };
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('Name=')) {
        result.Name = trimmed.substring(5);
      } else if (trimmed.startsWith('Exec=')) {
        result.Exec = trimmed.substring(5);
      } else if (trimmed.startsWith('Hidden=')) {
        result.Hidden = trimmed.substring(7).toLowerCase() === 'true';
      }
    }
    return result;
  } catch {
    return null;
  }
}

/* ── Get startup items ───────────────────────────────────────── */

async function getStartupItems() {
  if (platform === 'darwin') return getStartupItemsMac();
  if (platform === 'linux') return getStartupItemsLinux();
  return getStartupItemsWindows();
}

/* ── Get startup items: Windows ──────────────────────────────── */

async function getStartupItemsWindows() {
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

/* ── Get startup items: macOS ────────────────────────────────── */

async function getStartupItemsMac() {
  const items = [];
  const disabledItems = store.get('disabledItems') || [];
  const home = os.homedir();

  // 1. User LaunchAgents (~/Library/LaunchAgents/*.plist)
  const userAgentsDir = path.join(home, 'Library', 'LaunchAgents');
  try {
    if (fs.existsSync(userAgentsDir)) {
      const files = fs.readdirSync(userAgentsDir).filter(f => f.endsWith('.plist'));
      for (const file of files) {
        const filePath = path.join(userAgentsDir, file);
        const plist = parsePlist(filePath);
        if (!plist) continue;
        const label = plist.Label || path.basename(file, '.plist');
        const command = plist.ProgramArguments
          ? plist.ProgramArguments.join(' ')
          : (plist.Program || '');
        items.push({
          id: 'user-agent_' + label,
          name: label,
          command: command,
          path: filePath,
          source: 'user-agent',
          enabled: plist.Disabled !== true,
          type: 'user-agent'
        });
      }
    }
  } catch { /* ignore */ }

  // 2. System LaunchDaemons (/Library/LaunchDaemons/*.plist) — admin only
  if (isAdmin) {
    const systemDaemonsDir = '/Library/LaunchDaemons';
    try {
      if (fs.existsSync(systemDaemonsDir)) {
        const files = fs.readdirSync(systemDaemonsDir).filter(f => f.endsWith('.plist'));
        for (const file of files) {
          const filePath = path.join(systemDaemonsDir, file);
          const plist = parsePlist(filePath);
          if (!plist) continue;
          const label = plist.Label || path.basename(file, '.plist');
          const command = plist.ProgramArguments
            ? plist.ProgramArguments.join(' ')
            : (plist.Program || '');
          items.push({
            id: 'system-daemon_' + label,
            name: label,
            command: command,
            path: filePath,
            source: 'system-daemon',
            enabled: plist.Disabled !== true,
            type: 'system-daemon'
          });
        }
      }
    } catch { /* ignore */ }
  }

  // Enrich with file info (file size)
  for (const item of items) {
    const exePath = extractExePathUnix(item.command);
    if (exePath) {
      try {
        const stat = fs.statSync(exePath);
        item.fileSize = stat.size;
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

/* ── Get startup items: Linux ────────────────────────────────── */

async function getStartupItemsLinux() {
  const items = [];
  const disabledItems = store.get('disabledItems') || [];
  const home = os.homedir();

  // 1. User autostart (~/.config/autostart/*.desktop)
  const userAutostartDir = path.join(home, '.config', 'autostart');
  try {
    if (fs.existsSync(userAutostartDir)) {
      const files = fs.readdirSync(userAutostartDir).filter(f => f.endsWith('.desktop'));
      for (const file of files) {
        const filePath = path.join(userAutostartDir, file);
        const desktop = parseDesktopFile(filePath);
        if (!desktop) continue;
        const name = desktop.Name || path.basename(file, '.desktop');
        items.push({
          id: 'autostart_' + name,
          name: name,
          command: desktop.Exec || '',
          path: filePath,
          source: 'autostart',
          enabled: !desktop.Hidden,
          type: 'autostart'
        });
      }
    }
  } catch { /* ignore */ }

  // 2. System autostart (/etc/xdg/autostart/*.desktop)
  const systemAutostartDir = '/etc/xdg/autostart';
  try {
    if (fs.existsSync(systemAutostartDir)) {
      const files = fs.readdirSync(systemAutostartDir).filter(f => f.endsWith('.desktop'));
      for (const file of files) {
        const filePath = path.join(systemAutostartDir, file);
        const desktop = parseDesktopFile(filePath);
        if (!desktop) continue;
        const name = desktop.Name || path.basename(file, '.desktop');
        items.push({
          id: 'autostart_sys_' + name,
          name: name,
          command: desktop.Exec || '',
          path: filePath,
          source: 'autostart',
          enabled: !desktop.Hidden,
          type: 'autostart-system'
        });
      }
    }
  } catch { /* ignore */ }

  // 3. Systemd user services
  try {
    const raw = await runShell('systemctl --user list-unit-files --type=service --no-pager --plain');
    if (raw) {
      const lines = raw.split('\n');
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2 && parts[0].endsWith('.service')) {
          const serviceName = parts[0];
          const state = parts[1]; // enabled, disabled, static, masked, etc.
          items.push({
            id: 'systemd_' + serviceName,
            name: serviceName,
            command: serviceName,
            source: 'systemd',
            enabled: state === 'enabled',
            type: 'systemd'
          });
        }
      }
    }
  } catch { /* ignore */ }

  // Enrich with file info (file size for autostart executables)
  for (const item of items) {
    if (item.type === 'autostart' || item.type === 'autostart-system') {
      const exePath = extractExePathUnix(item.command);
      if (exePath) {
        try {
          const stat = fs.statSync(exePath);
          item.fileSize = stat.size;
        } catch { /* ignore */ }
      }
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

/* ── Path extraction helpers ─────────────────────────────────── */

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

function extractExePathUnix(cmd) {
  if (!cmd) return null;
  // Take the first token (the executable), stripping any field codes like %u, %F
  let p = cmd.trim().split(/\s+/)[0];
  // Remove quotes
  p = p.replace(/^["']|["']$/g, '');
  if (p && fs.existsSync(p)) return p;
  // Try resolving via which
  try {
    const resolved = execSync(`which '${sanitizeShellArg(p)}'`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    if (resolved) return resolved;
  } catch { /* ignore */ }
  return p || null;
}

/* ── Enable / Disable ────────────────────────────────────────── */

async function disableItem(item) {
  const disabledItems = store.get('disabledItems') || [];

  if (platform === 'win32') {
    await disableItemWindows(item);
  } else if (platform === 'darwin') {
    await disableItemMac(item);
  } else {
    await disableItemLinux(item);
  }

  item.enabled = false;
  // Track in store
  const exists = disabledItems.find(d => d.id === item.id);
  if (!exists) disabledItems.push(item);
  store.set('disabledItems', disabledItems);
}

async function disableItemWindows(item) {
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
}

async function disableItemMac(item) {
  if (item.type === 'user-agent' || item.type === 'system-daemon') {
    const plistPath = item.path;
    if (plistPath && fs.existsSync(plistPath)) {
      // Try to unload via launchctl
      try {
        const uid = runShellSync('id -u');
        await runShell(`launchctl bootout gui/${uid} '${sanitizeShellArg(plistPath)}'`);
      } catch { /* ignore — may not be loaded */ }
      // Rename to .plist.disabled
      try {
        fs.renameSync(plistPath, plistPath + '.disabled');
        item.path = plistPath + '.disabled';
      } catch { /* ignore */ }
    }
  }
}

async function disableItemLinux(item) {
  if (item.type === 'autostart') {
    // Add Hidden=true to the .desktop file
    const filePath = item.path;
    if (filePath && fs.existsSync(filePath)) {
      try {
        let content = fs.readFileSync(filePath, 'utf8');
        if (content.includes('Hidden=')) {
          content = content.replace(/Hidden=.*/, 'Hidden=true');
        } else {
          content = content.trimEnd() + '\nHidden=true\n';
        }
        fs.writeFileSync(filePath, content, 'utf8');
      } catch { /* ignore */ }
    }
  } else if (item.type === 'systemd') {
    try {
      await runShell(`systemctl --user disable '${sanitizeShellArg(item.name)}'`);
    } catch { /* ignore */ }
  }
}

async function enableItem(item) {
  const disabledItems = store.get('disabledItems') || [];

  if (platform === 'win32') {
    await enableItemWindows(item);
  } else if (platform === 'darwin') {
    await enableItemMac(item);
  } else {
    await enableItemLinux(item);
  }

  // Remove from disabled tracking
  store.set('disabledItems', disabledItems.filter(d => d.id !== item.id));
}

async function enableItemWindows(item) {
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
}

async function enableItemMac(item) {
  if (item.type === 'user-agent' || item.type === 'system-daemon') {
    let plistPath = item.path;
    // Rename .plist.disabled back to .plist
    if (plistPath && plistPath.endsWith('.plist.disabled')) {
      const restoredPath = plistPath.replace(/\.disabled$/, '');
      try {
        fs.renameSync(plistPath, restoredPath);
        plistPath = restoredPath;
        item.path = restoredPath;
      } catch { /* ignore */ }
    }
    // Load via launchctl
    if (plistPath && fs.existsSync(plistPath)) {
      try {
        const uid = runShellSync('id -u');
        await runShell(`launchctl bootstrap gui/${uid} '${sanitizeShellArg(plistPath)}'`);
      } catch { /* ignore — may already be loaded */ }
    }
  }
}

async function enableItemLinux(item) {
  if (item.type === 'autostart') {
    // Remove Hidden=true from the .desktop file
    const filePath = item.path;
    if (filePath && fs.existsSync(filePath)) {
      try {
        let content = fs.readFileSync(filePath, 'utf8');
        content = content.replace(/^Hidden=true\n?/m, '');
        fs.writeFileSync(filePath, content, 'utf8');
      } catch { /* ignore */ }
    }
  } else if (item.type === 'systemd') {
    try {
      await runShell(`systemctl --user enable '${sanitizeShellArg(item.name)}'`);
    } catch { /* ignore */ }
  }
}

/* ── Add / Remove ────────────────────────────────────────────── */

async function addItem(name, command) {
  if (platform === 'win32') {
    await addItemWindows(name, command);
  } else if (platform === 'darwin') {
    await addItemMac(name, command);
  } else {
    await addItemLinux(name, command);
  }
}

async function addItemWindows(name, command) {
  // Add to HKCU Run
  await ps(`Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name '${name.replace(/'/g, "''")}' -Value '${command.replace(/'/g, "''")}'`);
}

async function addItemMac(name, command) {
  const home = os.homedir();
  const agentsDir = path.join(home, 'Library', 'LaunchAgents');

  // Ensure the directory exists
  if (!fs.existsSync(agentsDir)) {
    fs.mkdirSync(agentsDir, { recursive: true });
  }

  // Sanitize the label for the plist filename
  const label = 'com.startup-sentry.' + name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const plistPath = path.join(agentsDir, label + '.plist');

  // Split command into program arguments
  const args = command.match(/"[^"]*"|\S+/g) || [command];
  const cleanArgs = args.map(a => a.replace(/^"|"$/g, ''));

  const programArgsXml = cleanArgs.map(a => `    <string>${escapeXml(a)}</string>`).join('\n');

  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArgsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;

  fs.writeFileSync(plistPath, plistContent, 'utf8');

  // Load it
  try {
    const uid = runShellSync('id -u');
    await runShell(`launchctl bootstrap gui/${uid} '${sanitizeShellArg(plistPath)}'`);
  } catch { /* ignore */ }
}

async function addItemLinux(name, command) {
  const home = os.homedir();
  const autostartDir = path.join(home, '.config', 'autostart');

  // Ensure the directory exists
  if (!fs.existsSync(autostartDir)) {
    fs.mkdirSync(autostartDir, { recursive: true });
  }

  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const desktopPath = path.join(autostartDir, safeName + '.desktop');

  const desktopContent = `[Desktop Entry]
Type=Application
Name=${name}
Exec=${command}
Hidden=false
X-GNOME-Autostart-enabled=true
`;

  fs.writeFileSync(desktopPath, desktopContent, 'utf8');
}

/* ── XML escaping helper for plist generation ────────────────── */

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/* ── Remove item ─────────────────────────────────────────────── */

async function removeItem(item) {
  if (platform === 'win32') {
    await removeItemWindows(item);
  } else if (platform === 'darwin') {
    await removeItemMac(item);
  } else {
    await removeItemLinux(item);
  }

  // Also remove from disabled tracking
  const disabledItems = store.get('disabledItems') || [];
  store.set('disabledItems', disabledItems.filter(d => d.id !== item.id));
}

async function removeItemWindows(item) {
  if (item.type === 'hkcu') {
    await ps(`Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name '${item.name.replace(/'/g, "''")}' -ErrorAction SilentlyContinue`);
  } else if (item.type === 'hklm' && isAdmin) {
    await ps(`Remove-ItemProperty -Path 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name '${item.name.replace(/'/g, "''")}' -ErrorAction SilentlyContinue`);
  } else if (item.type === 'folder') {
    try { fs.unlinkSync(item.command); } catch { /* ignore */ }
  } else if (item.type === 'task') {
    await ps(`Unregister-ScheduledTask -TaskName '${item.name.replace(/'/g, "''")}' -Confirm:$false -ErrorAction SilentlyContinue`);
  }
}

async function removeItemMac(item) {
  if (item.type === 'user-agent' || item.type === 'system-daemon') {
    const plistPath = item.path;
    if (plistPath) {
      // Unload first if loaded
      try {
        const uid = runShellSync('id -u');
        await runShell(`launchctl bootout gui/${uid} '${sanitizeShellArg(plistPath)}'`);
      } catch { /* ignore */ }
      // Delete the file (check both .plist and .plist.disabled)
      try {
        if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
        if (fs.existsSync(plistPath + '.disabled')) fs.unlinkSync(plistPath + '.disabled');
      } catch { /* ignore */ }
    }
  }
}

async function removeItemLinux(item) {
  if (item.type === 'autostart') {
    const filePath = item.path;
    if (filePath) {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch { /* ignore */ }
    }
  } else if (item.type === 'systemd') {
    try {
      await runShell(`systemctl --user disable '${sanitizeShellArg(item.name)}'`);
      // Attempt to remove the unit file if it's a user unit
      const unitPath = path.join(os.homedir(), '.config', 'systemd', 'user', item.name);
      if (fs.existsSync(unitPath)) {
        fs.unlinkSync(unitPath);
        await runShell('systemctl --user daemon-reload');
      }
    } catch { /* ignore */ }
  }
}

/* ── Open file location ──────────────────────────────────────── */

function openLocation(command) {
  if (platform === 'win32') {
    const exePath = extractExePath(command);
    if (exePath && fs.existsSync(exePath)) {
      shell.showItemInFolder(exePath);
    } else if (command) {
      const raw = command.replace(/^["']|["']$/g, '').split(' ')[0];
      if (fs.existsSync(raw)) {
        shell.showItemInFolder(raw);
      }
    }
  } else {
    const exePath = extractExePathUnix(command);
    if (exePath && fs.existsSync(exePath)) {
      shell.showItemInFolder(exePath);
    }
  }
}

/* ── Self-elevate ────────────────────────────────────────────── */

function selfElevate() {
  const appPath = app.getPath('exe');

  if (platform === 'win32') {
    guard.exec(`powershell -Command "Start-Process '${appPath}' -Verb RunAs"`, () => {
      app.isQuitting = true;
      app.quit();
    });
  } else if (platform === 'darwin') {
    const escapedPath = appPath.replace(/'/g, "'\\''");
    guard.exec(`osascript -e 'do shell script "open \\"${escapedPath.replace(/"/g, '\\\\\\"')}\\"" with administrator privileges'`, () => {
      app.isQuitting = true;
      app.quit();
    });
  } else {
    // Linux: use pkexec if available
    guard.exec(`which pkexec`, (err) => {
      const elevateCmd = err ? `sudo '${sanitizeShellArg(appPath)}'` : `pkexec '${sanitizeShellArg(appPath)}'`;
      guard.exec(elevateCmd, () => {
        app.isQuitting = true;
        app.quit();
      });
    });
  }
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
    guard.init(app);
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
