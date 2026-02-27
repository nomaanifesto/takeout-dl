#!/usr/bin/env node

const { intro, outro, text, confirm, spinner: createSpinner, log, note, cancel, isCancel } = require('@clack/prompts');
const { chromium } = require('playwright');
const chalk = require('chalk');
const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseTakeoutUrl(url) {
  try {
    const u = new URL(url.trim());
    const archiveId = u.searchParams.get('j');
    const userId = u.searchParams.get('user');
    if (archiveId && userId) return { archiveId, userId };
  } catch {}
  return null;
}

function formatBytes(bytes) {
  if (bytes >= 1e9) return chalk.cyan(`${(bytes / 1e9).toFixed(2)} GB`);
  if (bytes >= 1e6) return chalk.yellow(`${(bytes / 1e6).toFixed(1)} MB`);
  return `${bytes} B`;
}

function formatElapsed(startMs) {
  const s = Math.floor((Date.now() - startMs) / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function waitForEnter() {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('', () => { rl.close(); resolve(); });
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.clear();

  intro(
    chalk.bgBlue.white.bold('  takeout-dl  ') +
    chalk.dim('  Google Takeout batch downloader')
  );

  // ── Step 1: Parse a download URL ─────────────────────────────────────────

  log.info('Open your Takeout email, right-click any download button, and copy the link.');

  const urlInput = await text({
    message: 'Paste a download URL',
    placeholder: 'https://takeout.google.com/takeout/download?j=...&i=0&user=...',
    validate: v => {
      if (!v.trim()) return 'Required';
      if (!parseTakeoutUrl(v)) return 'Could not find archive ID and user ID in that URL';
    },
  });
  if (isCancel(urlInput)) { cancel('Cancelled'); process.exit(0); }

  const { archiveId, userId } = parseTakeoutUrl(urlInput);
  log.success(`Archive: ${chalk.cyan(archiveId)}`);
  log.success(`User:    ${chalk.cyan(userId)}`);

  // ── Step 2: Total number of zip files ────────────────────────────────────

  const totalInput = await text({
    message: 'How many zip files does your archive have?',
    placeholder: '355',
    validate: v => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 1) return 'Enter a number greater than 0';
    },
  });
  if (isCancel(totalInput)) { cancel('Cancelled'); process.exit(0); }
  const total = parseInt(totalInput, 10);

  // ── Step 3: Resume point ─────────────────────────────────────────────────

  const startInput = await text({
    message: 'Start from which part? (0 = beginning, change to resume)',
    initialValue: '0',
    validate: v => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 0) return 'Enter 0 or greater';
      if (n >= total) return `Must be less than total (${total})`;
    },
  });
  if (isCancel(startInput)) { cancel('Cancelled'); process.exit(0); }
  const start = parseInt(startInput, 10);

  // ── Step 4: Output directory ─────────────────────────────────────────────

  const outputInput = await text({
    message: 'Where should the zip files be saved?',
    initialValue: path.join(os.homedir(), 'Downloads', 'takeout'),
    validate: v => { if (!v.trim()) return 'Required'; },
  });
  if (isCancel(outputInput)) { cancel('Cancelled'); process.exit(0); }
  const outputDir = path.resolve(outputInput.replace(/^~/, os.homedir()));

  // ── Summary & confirm ─────────────────────────────────────────────────────

  const end = total - 1;
  const count = end - start + 1;

  note(
    [
      `Archive   ${chalk.cyan(archiveId)}`,
      `User      ${chalk.cyan(userId)}`,
      `Parts     ${chalk.yellow(start)} → ${chalk.yellow(end)}  ${chalk.dim(`(${count} files)`)}`,
      `Output    ${chalk.green(outputDir)}`,
    ].join('\n'),
    'Plan'
  );

  const ready = await confirm({ message: 'Start downloading?' });
  if (isCancel(ready) || !ready) { cancel('Cancelled'); process.exit(0); }

  // ── Launch browser ────────────────────────────────────────────────────────

  fs.mkdirSync(outputDir, { recursive: true });
  const profileDir = path.join(os.homedir(), '.takeout-dl-profile');
  fs.mkdirSync(profileDir, { recursive: true });

  const launchSpinner = createSpinner();
  launchSpinner.start('Launching Chrome...');

  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: false,
    acceptDownloads: true,
    downloadsPath: outputDir,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://google.com');

  launchSpinner.stop('Chrome is open');

  log.warn('Sign into Google in the browser window, then come back here.');
  process.stdout.write(chalk.dim('  Press Enter when ready... '));
  await waitForEnter();
  console.log();

  // ── Download loop ─────────────────────────────────────────────────────────

  const failed = [];
  let completed = 0;
  let skipped = 0;
  const startTime = Date.now();

  for (let i = start; i <= end; i++) {
    const partNum = i - start + 1;
    const url = `https://takeout.google.com/takeout/download?j=${archiveId}&i=${i}&user=${userId}`;
    const progress = chalk.dim(`[${partNum}/${count}]`);

    const sp = createSpinner();
    sp.start(`${progress} Downloading part ${i}...`);

    const tab = await context.newPage();

    try {
      const [download] = await Promise.all([
        tab.waitForEvent('download', { timeout: 600_000 }),
        tab.goto(url),
      ]);

      const filename = download.suggestedFilename();
      const destPath = path.join(outputDir, filename);

      // Skip if already fully downloaded
      if (fs.existsSync(destPath) && fs.statSync(destPath).size > 1024 * 1024) {
        sp.stop(`${chalk.dim('⟳')} ${progress} ${chalk.dim(filename)} — already exists`);
        await download.cancel();
        skipped++;
        continue;
      }

      if (fs.existsSync(destPath)) fs.unlinkSync(destPath); // remove previous partial

      await download.saveAs(destPath);
      const size = fs.statSync(destPath).size;

      if (size < 1024 * 1024) {
        fs.unlinkSync(destPath);
        throw new Error('Received an HTML page instead of a zip — session may have expired. Re-run to resume.');
      }

      sp.stop(
        `${chalk.green('✓')} ${progress} ${chalk.bold(filename)}  ` +
        `${formatBytes(size)}  ${chalk.dim(formatElapsed(startTime))}`
      );
      completed++;

    } catch (err) {
      sp.stop(`${chalk.red('✗')} ${progress} Part ${i} — ${chalk.red(err.message)}`);
      failed.push(i);
    } finally {
      await tab.close();
    }

    if (i < end) await sleep(500);
  }

  await context.close();

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log();
  note(
    [
      `${chalk.green('✓')} Downloaded  ${chalk.bold(completed)}`,
      `${chalk.dim('⟳')} Skipped     ${skipped}`,
      `${chalk.red('✗')} Failed      ${failed.length}`,
      `   Time        ${formatElapsed(startTime)}`,
      failed.length > 0
        ? `\n${chalk.yellow('Failed parts:')} ${failed.join(', ')}\nRe-run and enter ${Math.min(...failed)} as the start part.`
        : '',
    ].filter(Boolean).join('\n'),
    'Summary'
  );

  if (completed + skipped === count) {
    outro(chalk.green('All done! Import into Immich with:') + '\n\n' +
      chalk.dim(`  immich-go upload google-photos \\\n`) +
      chalk.dim(`    --server http://localhost:2283 \\\n`) +
      chalk.dim(`    --api-key YOUR_KEY \\\n`) +
      chalk.dim(`    ${outputDir}`)
    );
  } else {
    outro(chalk.yellow('Finished with errors. Re-run to retry failed parts.'));
  }
}

main().catch(err => {
  log.error(err.message);
  process.exit(1);
});
