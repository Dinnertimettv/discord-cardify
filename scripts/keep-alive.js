// Runs the bot in the background and starts it again whenever it stops - a
// crash, a lost connection at startup, or /restart. Nothing here needs a
// PowerShell window, so closing (or crashing) one can't take the bot down.
//   npm run background   starts this with no window
//   npm run autostart    also starts it whenever you log in to Windows
//   npm run stop         stops this and the bot
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { KEEP_ALIVE_PORT, RESTART_EXIT_CODE, findRunningBot, takeLock } = require('../instance');

const BOT_DIR = path.join(__dirname, '..');
const LOG_FILE = path.join(BOT_DIR, 'logs', 'keep-alive.log');
// After a crash, wait a little before starting again, and longer each time it
// keeps crashing (so a bad token or no internet doesn't spin), up to 5 minutes.
const FIRST_WAIT_MS = 5_000;
const LONGEST_WAIT_MS = 5 * 60_000;
// A run this long counts as healthy, so the next crash waits the short time again.
const HEALTHY_RUN_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(text) {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${text}\n`);
}

// Resolves with the bot's exit code (or the signal that ended it).
function runBot() {
  return new Promise((resolve) => {
    // The bot writes its own logs/bot.log, so it needs no window or output.
    const child = spawn(process.execPath, [path.join(BOT_DIR, 'index.js')], {
      cwd: BOT_DIR,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, SPORK_KEEP_ALIVE: '1' },
    });
    log(`Started the bot (process ${child.pid}).`);
    child.on('error', (err) => resolve(`error: ${err.message}`));
    child.on('exit', (code, signal) => resolve(code ?? signal));
  });
}

(async () => {
  const lock = await takeLock(KEEP_ALIVE_PORT);
  if (!lock.ok) {
    console.log(`The keep-alive is already running (process ${lock.runningPid}).`);
    return;
  }
  log(`Keep-alive started (process ${process.pid}).`);
  let wait = FIRST_WAIT_MS;
  for (;;) {
    // A copy started some other way (npm start in a window): leave it be, and
    // take over once it stops.
    if (await findRunningBot()) {
      await sleep(30_000);
      continue;
    }
    const startedAt = Date.now();
    const exit = await runBot();
    if (exit === RESTART_EXIT_CODE) {
      log('The bot restarted itself (/restart).');
      wait = FIRST_WAIT_MS;
      continue;
    }
    if (Date.now() - startedAt > HEALTHY_RUN_MS) wait = FIRST_WAIT_MS;
    log(`The bot stopped (exit ${exit}) - starting it again in ${wait / 1000} seconds. See logs/bot.log for why.`);
    await sleep(wait);
    wait = Math.min(wait * 2, LONGEST_WAIT_MS);
  }
})();
