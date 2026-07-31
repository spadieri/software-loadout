# Software Loadout

Windows desktop app to browse a curated software catalog, detect what's already installed, and download/launch installers with a single click. Downloads are handled by the best channel available: a bundled wget for direct links, the GitHub Releases API for auto-updating assets, or the browser for vendors without stable direct links.

## Download

Grab the latest release from the [Releases page](https://github.com/spadieri/software-loadout/releases):

- **`software-loadout-Setup-x.y.z-x64.exe`** — standard installer (recommended). Creates desktop/start menu shortcuts and auto-updates in the background.
- **`software-loadout-x.y.z-portable.exe`** — single-file executable, no installation. Notifies you when a new version is released but won't self-update.

Both require **Windows 10 or 11 (x64)**. No runtime (Node.js, .NET, etc.) needs to be installed.

## Features

- 9 software categories (Browsers, Development, Multimedia, Utilities, Security, Communication, Office, System, AI)
- 400+ curated software entries, links verified periodically
- Automatic detection of already-installed software (green checkmark)
- Download with progress bar via bundled wget
- GitHub Releases resolver: always downloads the latest release asset
- Browser fallback for software without stable direct links
- Automatic installer launch after download
- Search bar to filter software
- Language toggle (Italian / English)
- Modern dark mode UI
- Auto-update from GitHub Releases

## Build from source

Requires [Node.js](https://nodejs.org/) 18+ and Windows 10/11.

```bash
git clone https://github.com/spadieri/software-loadout.git
cd software-loadout
npm install
npm start                # run in dev mode
npm run build            # build both installer + portable (output in dist/)
npm run build:installer  # NSIS installer only
npm run build:portable   # portable .exe only
```

## Release process

Releases are built and published automatically by **GitHub Actions** (see [.github/workflows/release.yml](.github/workflows/release.yml)). The workflow runs on `windows-latest`, builds both NSIS installer and portable `.exe`, and uploads them to GitHub Releases as a draft.

```bash
npm version patch        # or minor / major — creates commit + tag
git push --follow-tags   # triggers the workflow
```

Then publish the draft from the [Releases page](https://github.com/spadieri/software-loadout/releases). The workflow can also be triggered manually via Actions → Release → Run workflow.

## Tech Stack

- Electron
- electron-builder (NSIS installer + portable)
- electron-updater (auto-update from GitHub Releases)
- HTML/CSS/JS (vanilla)
- wget (bundled)
- Windows Registry for software detection

## License

ISC
