---
title: Installation
description: Install Zylara on Windows, macOS or Linux, verify the download, run it for the first time and uninstall without losing data.
---

Zylara is distributed as a signed release on GitHub: an installer for Windows, a disk image
for macOS and native packages for Linux. Every release also publishes `SHA256SUMS.txt` and
`release.json` next to the artifacts.

## Before you install

| Requirement | Details |
| --- | --- |
| Windows | Windows 10/11 with WebView2. If WebView2 is missing, the installer runs the official Microsoft bootstrapper. |
| macOS | macOS 11 or newer. Official builds are **arm64** (Apple silicon); there is no Intel build. |
| Linux | x64 distribution able to install `.deb`/`.rpm`, or FUSE for the `.AppImage`. Packages are built against an Ubuntu 22.04 baseline and need WebKitGTK. |
| Provider credential | One of the supported providers — see [Models and providers](/docs/models-and-providers). The app opens, but cannot answer, without one. |
| Optional | Python 3.9+ and/or Node for [code execution](/docs/code-execution); Docker for the command sandbox and [computer use](/docs/computer-use). |

Node and Rust are **not** required: the app ships as a compiled binary.

## Windows

1. Run `Zylara-Setup-<version>-windows-x64.exe`.
2. Choose the install scope:
   - **Just for me** — installs to `%LOCALAPPDATA%\Programs\Zylara`, no administrator
     prompt, per-user shortcuts.
   - **For all users** — installs to `%ProgramFiles%\Zylara`, requires elevation, and
     registers the app for every account.
3. Choose the folder (the default is fine for most cases).
4. Pick the options: **Desktop shortcut**, **Start menu shortcut**, **Open Zylara when
   finished**.
5. Wait for the progress step. If WebView2 is missing, the installer downloads and installs
   it silently before finishing.

The scope is fixed after installation: to change it, uninstall and install again.

The official installers are **not code-signed**, so Windows SmartScreen may show "Windows
protected your PC". Use **More info → Run anyway** only if you downloaded the file from the
project's release page and the SHA-256 matches.

### Silent and scripted installs

```powershell
Zylara-Setup-<version>-windows-x64.exe --silent --scope user
```

| Flag | Effect |
| --- | --- |
| `--setup` | Opens the wizard (same as double-clicking) |
| `--silent` | No UI; errors go to the installer log |
| `--scope user` / `--scope machine` | Per-user or per-machine install |
| `--dir <path>` | Target folder |
| `--desktop` / `--no-desktop` | Create or skip the desktop shortcut |
| `--start-menu` / `--no-start-menu` | Create or skip the Start menu entry |
| `--launch` / `--no-launch` | Launch the app when the install finishes |

The installer writes a log to `%TEMP%\Zylara-Setup-<date>.log`.

## macOS

1. Open the `.dmg` and drag **Zylara** to `Applications`.
2. The build is signed ad-hoc, not notarized. If Gatekeeper blocks the first launch,
   right-click the app and choose **Open**, or allow it in **System Settings → Privacy &
   Security**.
3. The app is arm64-only; on an Intel Mac it will not run.

## Linux

| Package | Command |
| --- | --- |
| Debian/Ubuntu | `sudo apt install ./Zylara-<version>-linux-x64.deb` |
| Fedora/RHEL | `sudo dnf install ./Zylara-<version>-linux-x64.rpm` |
| Any distribution | `chmod +x Zylara-<version>-linux-x64.AppImage && ./Zylara-<version>-linux-x64.AppImage` |

The AppImage bundles the media framework, so audio and video previews work without extra
packages. Without FUSE, run the AppImage with `--appimage-extract-and-run`.

### Managed per-user install (Linux x64 and macOS arm64)

The release also ships `Zylara-install-<version>-linux-x64.sh` and
`Zylara-install-<version>-macos-arm64.sh`. They verify size and SHA-256 and install per
user, without administrator rights:

- Linux: `~/.local/opt/zylara/Zylara.AppImage` plus a `zylara-managed.desktop` entry.
- macOS: `~/Applications/Zylara.app`.

Managed installs record themselves in `<app-data>/managed-install.json`, which is what
enables **Install and restart** for updates — see [Updates](/docs/settings-reference#about).
The scripts are not silent: they print what they will do before writing.

## Verify the download

Every release publishes `SHA256SUMS.txt`. Compare it with the file you downloaded:

```powershell
Get-FileHash .\Zylara-Setup-<version>-windows-x64.exe -Algorithm SHA256
```

```bash
sha256sum -c SHA256SUMS.txt
```

Do not install a binary whose hash does not match, or that came from anywhere other than
the project's release page.

## First launch

On first start Zylara creates its data folder and opens the welcome screen. With no
credential configured, the composer shows a banner with an **Open Providers** action —
that is the expected state, not an error.

- Windows: `%APPDATA%\app.zylara.chat`
- macOS: `~/Library/Application Support/app.zylara.chat`
- Linux: `~/.local/share/app.zylara.chat`

See [Data and privacy](/docs/data-and-privacy) for what is stored there.

## Uninstall

| Platform | How |
| --- | --- |
| Windows | **Settings → Apps → Installed apps → Zylara → Uninstall**, or run `Uninstall Zylara.exe` from the install folder. Silent: `Uninstall Zylara.exe --silent`. |
| macOS | Drag `Zylara.app` to the Trash; remove the data folder manually if you want to erase everything. |
| Linux | Remove the package (`apt remove zylara` / `dnf remove zylara`) or delete the AppImage and the `.desktop` entry. |

By default the uninstaller **keeps your data** (conversations, attachments, artifacts,
settings and API keys). The Windows uninstaller offers **Also remove my data**; the
`--purge` flag does the same silently. That step cannot be undone.

Next: [First steps](/docs/first-steps).
