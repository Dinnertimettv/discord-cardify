// Checks on, starts, or stops the copy of the bot running on this PC, wherever
// it was started from (a terminal window, or in the background with no window).
//   npm run status
//   npm run stop
//   npm run background         start it with no window, restarting it if it stops
//   npm run autostart          also do that whenever you log in to Windows
//   npm run autostart -- off   stop doing that
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findRunningBot, findKeepAlive } = require('../instance');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BOT_DIR = path.join(__dirname, '..');
const KEEP_ALIVE = path.join(__dirname, 'keep-alive.js');
// Windows runs everything in this folder when you log in.
const STARTUP_FILE = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Spork.vbs'
);

async function waitFor(check, wanted) {
  for (let i = 0; i < 40 && Boolean(await check()) !== wanted; i++) await sleep(250);
  return Boolean(await check()) === wanted;
}

async function stopProcess(pid, check) {
  try {
    process.kill(pid);
  } catch {
    // Already gone.
  }
  // The lock port frees up as soon as the process has exited.
  return waitFor(check, false);
}

async function stop() {
  const keepAlivePid = await findKeepAlive();
  const botPid = await findRunningBot();
  if (!keepAlivePid && !botPid) {
    console.log("The bot isn't running on this PC.");
    return;
  }
  // The keep-alive goes first, or it would start the bot straight back up.
  if (keepAlivePid && !(await stopProcess(keepAlivePid, findKeepAlive))) {
    console.log(`Asked the keep-alive (process ${keepAlivePid}) to stop, but it's still running.`);
    return;
  }
  if (keepAlivePid) console.log(`Stopped the keep-alive (process ${keepAlivePid}), so the bot won't start again by itself.`);
  if (botPid) {
    console.log((await stopProcess(botPid, findRunningBot)) ? `Stopped the bot (process ${botPid}).` : `Asked process ${botPid} to stop, but it's still running.`);
  }
}

// The little script Windows runs to start the keep-alive with no window (the
// 0), both at login (autostart) and for "npm run background".
function launcherScript() {
  const quote = (text) => `""${text}""`;
  return [
    "' Starts Spork in the background (no window). Made by Spork's scripts/bot-control.js;",
    "' for starting with Windows, remove it with \"npm run autostart -- off\".",
    'Set shell = CreateObject("WScript.Shell")',
    `shell.CurrentDirectory = "${BOT_DIR}"`,
    `shell.Run "${quote(process.execPath)} ${quote(KEEP_ALIVE)}", 0, False`,
    '',
  ].join('\r\n');
}

// UTF-16 with a byte-order mark, so folder names with accents survive.
const writeLauncher = (file) => fs.writeFileSync(file, `\ufeff${launcherScript()}`, 'utf16le');

// Starts the keep-alive so it outlives whatever ran this command. On Windows a
// program started from an editor or an app that runs commands can sit in a
// "job" that closes everything in it when that app closes (Node's detached
// start doesn't leave it). So Windows' own desktop (Explorer) starts it
// instead, through the same no-window script as autostart - just like at login.
// Returns false when that isn't available.
function startThroughDesktop() {
  if (process.platform !== 'win32') return false;
  const file = path.join(os.tmpdir(), 'spork-start.vbs');
  try {
    writeLauncher(file);
    spawnSync('explorer.exe', [file], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const startDirectly = () => spawn(process.execPath, [KEEP_ALIVE], { cwd: BOT_DIR, detached: true, stdio: 'ignore', windowsHide: true }).unref();

async function background() {
  const keepAlivePid = await findKeepAlive();
  if (keepAlivePid) {
    console.log(`The bot is already running in the background (keep-alive process ${keepAlivePid}).`);
    return;
  }
  const botPid = await findRunningBot();
  if (botPid) {
    console.log(`The bot is running in a window (process ${botPid}). Stop it first with "npm run stop", then run this again.`);
    return;
  }
  // Hidden, and on its own: it keeps going after this window closes.
  let started = startThroughDesktop() && (await waitFor(findRunningBot, true));
  if (!started && !(await findKeepAlive())) {
    startDirectly();
    started = await waitFor(findRunningBot, true);
  }
  if (started) {
    console.log('The bot is running in the background. You can close this window.');
    console.log('If it ever stops, it starts again by itself. Use /restart in Discord to restart it.');
  } else {
    console.log("Started the keep-alive, but the bot hasn't come up yet - look at logs/keep-alive.log and logs/bot.log.");
  }
}

function autostart(setting) {
  if (process.platform !== 'win32') {
    console.log('Starting with the computer is only set up for Windows here. Elsewhere, use pm2 or systemd to run "node scripts/keep-alive.js".');
    return;
  }
  if (setting === 'off') {
    fs.rmSync(STARTUP_FILE, { force: true });
    console.log("The bot won't start by itself when you log in any more.");
    return;
  }
  writeLauncher(STARTUP_FILE);
  console.log('The bot now starts by itself, in the background, whenever you log in to Windows.');
  console.log('Run "npm run background" to start it now too.');
}

(async () => {
  const [command, setting] = process.argv.slice(2);

  if (command === 'status') {
    const [botPid, keepAlivePid] = [await findRunningBot(), await findKeepAlive()];
    console.log(botPid ? `The bot is running (process ${botPid}).` : "The bot isn't running on this PC.");
    if (keepAlivePid) console.log(`It's kept running in the background (keep-alive process ${keepAlivePid}).`);
    if (process.platform === 'win32') {
      console.log(fs.existsSync(STARTUP_FILE) ? 'It starts by itself when you log in.' : "It doesn't start by itself when you log in (npm run autostart).");
    }
    return;
  }
  if (command === 'stop') return stop();
  if (command === 'background') return background();
  if (command === 'autostart') return autostart(setting);

  console.log('Usage: npm run status | npm run stop | npm run background | npm run autostart [-- off]');
})();
