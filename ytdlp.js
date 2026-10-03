// yt-dlp: the open-source tool the music player uses to get audio from
// YouTube (and to find Spotify songs there). Its official release is
// downloaded into bin/ the first time it's needed, and it updates itself once
// a day, since YouTube changes often. It's only ever given YouTube links and
// searches the music player builds itself - never arbitrary links.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BIN_DIR = path.join(__dirname, 'bin');
const ASSET = { win32: 'yt-dlp.exe', darwin: 'yt-dlp_macos' }[process.platform] ?? 'yt-dlp_linux';
const BINARY = process.env.YTDLP_PATH || path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const DOWNLOAD_URL = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ASSET}`;
const UPDATED_FILE = path.join(BIN_DIR, 'yt-dlp.updated');
const UPDATE_EVERY_MS = 24 * 60 * 60 * 1000;

// Used on every run: no config files from this PC, and Node (already here)
// to solve YouTube's JavaScript checks.
const BASE_ARGS = ['--ignore-config', '--no-warnings', '--js-runtimes', `node:${process.execPath}`];

let downloading = null;

function ensure() {
  if (fs.existsSync(BINARY)) return Promise.resolve(BINARY);
  downloading ??= (async () => {
    console.log(`Downloading yt-dlp (${ASSET}) from GitHub for the music player...`);
    const res = await fetch(DOWNLOAD_URL, { headers: { 'User-Agent': 'Cardify Discord bot' }, signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`yt-dlp download failed: HTTP ${res.status}`);
    fs.mkdirSync(BIN_DIR, { recursive: true });
    const tmp = `${BINARY}.download`;
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, BINARY);
    fs.writeFileSync(UPDATED_FILE, new Date().toISOString());
    console.log('yt-dlp is ready.');
    return BINARY;
  })().finally(() => {
    downloading = null;
  });
  return downloading;
}

// Runs yt-dlp and resolves with what it printed.
function run(args, { timeoutMs = 30_000 } = {}) {
  return ensure().then(
    (binary) =>
      new Promise((resolve, reject) => {
        const child = spawn(binary, [...BASE_ARGS, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stdout.on('data', (chunk) => (out += chunk));
        child.stderr.on('data', (chunk) => (err += chunk));
        const timer = setTimeout(() => child.kill(), timeoutMs);
        child.on('error', reject);
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve(out);
          else reject(new Error(err.trim().split('\n').pop() || `yt-dlp exited with code ${code}`));
        });
      })
  );
}

// A YouTube playlist or search, without opening every video: { title, entries: [{ id, title, duration, live }] }
async function list(url, { limit = 100 } = {}) {
  const out = await run(['--flat-playlist', '--dump-single-json', '--playlist-items', `1:${limit}`, '--', url]);
  const data = JSON.parse(out);
  return {
    title: data.title ?? null,
    entries: (data.entries ?? [])
      .filter((entry) => /^[\w-]{11}$/.test(entry.id ?? ''))
      .map((entry) => ({ id: entry.id, title: entry.title ?? 'YouTube video', duration: entry.duration ?? null, live: entry.live_status === 'is_live' })),
  };
}

// The audio of a YouTube video (or the first result of a YouTube search URL),
// written to stdout - the music player pipes it into ffmpeg.
function stream(url) {
  return spawn(
    BINARY,
    [...BASE_ARGS, '--quiet', '--no-progress', '--no-playlist', '--playlist-items', '1', '-f', 'bestaudio/best', '-o', '-', '--', url],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
  );
}

// Once a day: yt-dlp's own updater, from its official GitHub releases.
async function updateIfDue() {
  const last = fs.existsSync(UPDATED_FILE) ? Date.parse(fs.readFileSync(UPDATED_FILE, 'utf8')) : 0;
  if (Date.now() - last < UPDATE_EVERY_MS) return;
  fs.writeFileSync(UPDATED_FILE, new Date().toISOString());
  const out = await run(['-U'], { timeoutMs: 120_000 });
  const line = out.trim().split('\n').pop();
  if (line) console.log(`yt-dlp: ${line}`);
}

// Called once at startup: get yt-dlp ready, then keep it up to date.
function start() {
  const check = () => updateIfDue().catch((err) => console.error('yt-dlp update failed:', err.message));
  ensure()
    .then(check)
    .catch((err) => console.error("Couldn't get yt-dlp - YouTube and Spotify won't play:", err.message));
  setInterval(check, 60 * 60 * 1000).unref();
}

module.exports = { ensure, run, list, stream, start, BINARY };
