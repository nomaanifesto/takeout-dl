# takeout-dl

Download all parts of a Google Takeout archive from the command line.

Google Takeout can split your data into hundreds of zip files (355 in my case). Downloading them one by one is not an option. This tool automates it using Playwright — a real Chrome browser under the hood — which is the only approach that actually works.

---

## Why every other approach fails

### Cookie export + `aria2c` / `wget` / `curl`

The most obvious approach: export your browser cookies to a `cookies.txt` file and feed them to a download tool.

It doesn't work. Google Takeout downloads require an `OSID` cookie that is a **session-only cookie stored in browser memory**. It is never written to the cookie database on disk. Browser extensions like *Get cookies.txt LOCALLY* and libraries like `pycookiecheat` (which reads Chrome's SQLite database) cannot see it. Without `OSID`, Google redirects every request to a login page, and your download tool saves a 1.2 MB HTML file instead of a 2 GB zip.

### `fetch()` from the browser console

Running `fetch(downloadUrl)` from the Chrome DevTools console on the Takeout page should have access to the session. It doesn't work because the download URL **redirects** from `takeout.google.com` to `accounts.google.com` to verify auth. The browser blocks this redirect with a CORS error — `accounts.google.com` does not set `Access-Control-Allow-Origin` headers for cross-origin fetch requests.

```
Access to fetch at 'https://accounts.google.com/ServiceLogin?...'
(redirected from 'https://takeout.google.com/takeout/download?...')
has been blocked by CORS policy
```

### `a.click()` from the browser console

Creating an `<a>` element and clicking it is a real browser navigation, not a fetch — so CORS doesn't apply. This **does** work for the first download. Chrome then blocks all subsequent programmatic downloads with its multiple-download protection:

> *"This site is attempting to download multiple files. Do you want to allow this?"*

You can allow it in `chrome://settings/content/automaticDownloads`, but even after doing so, subsequent clicks are silently dropped. Only the first file reliably downloads per script invocation.

### DownThemAll! (browser extension)

DownThemAll supports batch URL patterns and runs inside the browser, so it has access to the cookie session. It still fails because Google Takeout download URLs require a `rapt` (re-authentication proof token) that is embedded in the Takeout page URL and **expires within minutes**. DownThemAll makes independent HTTP requests that don't carry the full browser navigation context, and by the time it processes the queue the token has expired.

Even with a fresh `rapt` token in every URL, DownThemAll downloads HTML login pages instead of zip files in practice.

### Playwright with headless Chromium

Playwright can automate a browser and capture downloads. Using Playwright's default Chromium (not Chrome) fails immediately at the login step:

> *"This browser or app may not be secure."*

Google rejects Chromium because it is not an official Chrome build.

### Playwright with Chrome but no anti-detection

Switching to `channel: 'chrome'` gets past the "not secure" screen, but Playwright injects JavaScript flags (`navigator.webdriver = true`, `--enable-automation`) that Google detects, and the login is blocked.

---

## What works

Playwright with a real Chrome install, automation flags disabled, and a persistent profile so you only log in once:

```js
chromium.launchPersistentContext(profileDir, {
  channel: 'chrome',
  headless: false,
  acceptDownloads: true,
  args: ['--disable-blink-features=AutomationControlled'],
  ignoreDefaultArgs: ['--enable-automation'],
});
```

Each file is opened in its own tab. Playwright captures the download event (including the auth redirect chain), saves the file to disk, and closes the tab before moving to the next one.

---

## Requirements

- Node.js 18+
- Google Chrome installed

## Installation

```bash
git clone https://github.com/Uxnomaan/takeout-dl
cd takeout-dl
npm install
```

`npm install` will also run `playwright install chrome`.

## Usage

```bash
node index.js
```

The TUI walks you through everything:

```
  ◆  Paste a download URL from your Takeout email
  │  https://takeout.google.com/takeout/download?j=...&i=0&user=...

  ◆  How many zip files does your archive have?
  │  355

  ◆  Start from which part? (0 = beginning, change to resume)
  │  0

  ◆  Where should the zip files be saved?
  │  /Volumes/nas/photos/takeout

  ┌─ Plan ──────────────────────────────────────────────────┐
  │  Archive   cd93e2fe-...                                  │
  │  Parts     0 → 354  (355 files)                         │
  │  Output    /Volumes/nas/photos/takeout                   │
  └─────────────────────────────────────────────────────────┘

  ◆  Start downloading? Yes

  → Chrome opens — sign into Google, press Enter to begin

  ✓ [1/355] takeout-20260226T034450Z-3-001.zip  2.10 GB  4s
  ✓ [2/355] takeout-20260226T034450Z-3-002.zip  2.10 GB  3m 12s
  ...
```

### Resuming

If the run is interrupted, rerun `node index.js` and enter the failed part number as the start. Files already downloaded (> 1 MB) are automatically skipped. The tool prints failed indices and the resume start number at the end of every run.

## After downloading: import into Immich

Once all zips are downloaded, import them directly into [Immich](https://immich.app) without extracting:

```bash
immich-go upload google-photos \
  --server http://localhost:2283 \
  --api-key YOUR_API_KEY \
  /path/to/output
```

`immich-go` reads Google Takeout zip files natively and preserves metadata (dates, albums, descriptions).
