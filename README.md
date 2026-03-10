# Startup Sentry

**Free & open-source Windows startup program manager.**

Take control of what runs when your computer boots. Startup Sentry gives you a clear, unified view of every program that launches at startup — whether it lives in the Windows Registry, the Startup folder, or scheduled tasks. Enable, disable, add, or remove entries with confidence.

## Features

- **Unified startup view** — see Registry (HKCU & HKLM), Startup folder, and scheduled task entries in one place
- **Enable / disable** startup programs without deleting them
- **Add new** startup entries (name + path)
- **Remove** entries with confirmation
- **Open file location** for any entry
- **Search & filter** across all startup items
- **Impact indicators** — file size and publisher info at a glance
- **Disabled section** — dedicated view for items you've turned off
- **System tray** — minimize to tray, stays out of your way
- **Settings** — start minimized, toggle HKLM visibility
- **Admin detection** — banner prompt when elevated privileges are needed
- **Dark emerald theme** — polished, modern UI

## Download

Grab the latest portable `.exe` from [Releases](https://github.com/Nimba-Solutions/Startup-Sentry/releases).
No installation required — run as Administrator for full functionality.

## Requirements

- Windows 10/11
- Administrator recommended (required for HKLM entries and scheduled tasks)

## Build from source

```bash
git clone https://github.com/Nimba-Solutions/Startup-Sentry.git
cd Startup-Sentry
npm install
npm start
```

## Development

```bash
# Run in development mode
npm start

# Build portable .exe
npm run dist

# Run tests
npm test
```

## How it works

Startup Sentry queries Windows startup locations using PowerShell:

- **Registry (HKCU):** `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` — per-user startup programs
- **Registry (HKLM):** `HKLM\Software\Microsoft\Windows\CurrentVersion\Run` — system-wide startup programs (requires Administrator)
- **Startup Folder:** `shell:startup` — shortcuts that run at login
- **Scheduled Tasks:** Tasks with logon triggers (best-effort, requires Administrator)

When you disable an entry, Startup Sentry removes the registry value (storing it for re-enabling) or renames the startup folder shortcut. Disabled items are tracked locally so they can be restored at any time.

## License

[BSL 1.1](LICENSE.md) — Converts to Apache 2.0 after four years per release.
**Author:** [Cloud Nimbus LLC](https://cloudnimbusllc.com)
