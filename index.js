#!/usr/bin/env node

const { chromium } = require('playwright');
const { program } = require('commander');
const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');

program
  .name('takeout-dl')
  .description('Download all parts of a Google Takeout archive')
  .requiredOption('-j, --archive-id <id>', 'Archive ID from the Takeout download URL')
  .requiredOption('-u, --user-id <id>', 'User ID from the Takeout download URL')
  .option('-s, --start <n>', 'First part index to download (0-based)', '0')
  .option('-e, --end <n>', 'Last part index to download (inclusive)', '354')
  .option('-o, --output <dir>', 'Directory to save zip files', './downloads')
  .option('--timeout <ms>', 'Per-file download timeout in milliseconds', '600000')
  .option('--profile <dir>', 'Chrome profile directory to persist login', '~/.takeout-dl-profile')
  .option('--delay <ms>', 'Delay between downloads in milliseconds', '1000')
  .addHelpText('after', `
Examples:
  # Download all 355 parts
  takeout-dl -j cd93e2fe-8de1-4abd-ad9e-03c5daa06a00 -u 108202292654209846206 -e 354 -o /mnt/nas/photos/takeout

  # Resume from part 42
  takeout-dl -j cd93e2fe-8de1-4abd-ad9e-03c5daa06a00 -u 108202292654209846206 -s 42 -e 354 -o /mnt/nas/photos/takeout

How to find your archive ID and user ID:
  Open the Google Takeout email, copy one of the download links. It looks like:
  https://takeout.google.com/takeout/download?j=<archive-id>&i=0&user=<user-id>
  `)
  .parse();

const opts = program.opts();

const ARCHIVE_ID = opts.archiveId;
const USER_ID = opts.userId;
const START = parseInt(opts.start, 10);
const END = parseInt(opts.end, 10);
const OUTPUT_DIR = path.resolve(opts.output.replace(/^~/, os.homedir()));
const TIMEOUT = parseInt(opts.timeout, 10);
const PROFILE_DIR = path.resolve(opts.profile.replace(/^~/, os.homedir()));
const DELAY = parseInt(opts.delay, 10);

function waitForEnter(prompt) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatBytes(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${bytes} B`;
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  const total = END - START + 1;
  console.log(`\ntakeout-dl: downloading parts ${START}–${END} (${total} files)`);
  console.log(`Output: ${OUTPUT_DIR}\n`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: false,
    acceptDownloads: true,
    downloadsPath: OUTPUT_DIR,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  // Mask automation fingerprint on every new page
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://google.com');

  await waitForEnter('>>> Sign into Google in the browser window that opened, then press Enter here to start downloading... ');

  const failed = [];
  let completed = 0;
  let skipped = 0;

  for (let i = START; i <= END; i++) {
    const partNum = i - START + 1;
    const url = `https://takeout.google.com/takeout/download?j=${ARCHIVE_ID}&i=${i}&user=${USER_ID}`;

    process.stdout.write(`[${partNum}/${total}] part ${i} ... `);

    const tab = await context.newPage();

    try {
      const [download] = await Promise.all([
        tab.waitForEvent('download', { timeout: TIMEOUT }),
        tab.goto(url),
      ]);

      const filename = download.suggestedFilename();
      const destPath = path.join(OUTPUT_DIR, filename);

      if (fs.existsSync(destPath)) {
        const existing = fs.statSync(destPath).size;
        if (existing > 1024 * 1024) { // > 1MB means it's a real zip, not an HTML error page
          console.log(`skipped (${filename} already exists)`);
          await download.cancel();
          skipped++;
          continue;
        }
        // Small file = previous failed download, overwrite it
        fs.unlinkSync(destPath);
      }

      await download.saveAs(destPath);
      const size = fs.statSync(destPath).size;

      if (size < 1024 * 1024) {
        // Downloaded an HTML error page instead of a zip
        fs.unlinkSync(destPath);
        throw new Error(`received HTML instead of zip (${formatBytes(size)}) — session may have expired`);
      }

      console.log(`✓  ${filename}  (${formatBytes(size)})`);
      completed++;
    } catch (err) {
      console.log(`✗  ${err.message}`);
      failed.push(i);
    } finally {
      await tab.close();
    }

    if (i < END) await sleep(DELAY);
  }

  console.log(`\n─────────────────────────────────────`);
  console.log(`Done.  ✓ ${completed} downloaded  ⟳ ${skipped} skipped  ✗ ${failed.length} failed`);

  if (failed.length > 0) {
    console.log(`\nFailed indices: ${failed.join(', ')}`);
    console.log(`Retry with: --start ${Math.min(...failed)} --end ${Math.max(...failed)}`);
  }

  await context.close();
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
