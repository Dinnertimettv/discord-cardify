// Makes sure only one copy of the bot runs on this PC - two copies would each
// repost and delete every link. The running copy holds a local port as its
// lock: the OS frees the port the moment the process dies, however it dies,
// so the lock can't go stale or be bypassed by deleting a file. Anyone who
// connects to the port is told the running copy's process id. The keep-alive
// (scripts/keep-alive.js) holds the next port up the same way.
const net = require('net');

const LOCK_PORT = Number(process.env.BOT_LOCK_PORT) || 47631;
const KEEP_ALIVE_PORT = LOCK_PORT + 1;
// The bot exits with this when /restart asks it to, so the keep-alive starts it
// again straight away instead of waiting as it does after a crash.
const RESTART_EXIT_CODE = 75;

// Resolves to the process id holding `port`, or null if nothing does.
function findHolder(port) {
  return new Promise((resolve) => {
    let reply = '';
    const socket = net.connect(port, '127.0.0.1');
    socket.setTimeout(2000, () => socket.destroy());
    socket.on('data', (chunk) => {
      reply += chunk;
    });
    socket.on('error', () => resolve(null));
    socket.on('close', () => resolve(Number(reply) || null));
  });
}

// Resolves to the running bot's process id, or null if it isn't running.
const findRunningBot = () => findHolder(LOCK_PORT);
// The same for the keep-alive that restarts the bot.
const findKeepAlive = () => findHolder(KEEP_ALIVE_PORT);

// Resolves to { ok: true } once this process holds the lock, or to
// { ok: false, runningPid } if another copy already does.
function takeLock(port = LOCK_PORT) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.end(String(process.pid)));
    server.once('error', async (err) => {
      if (err.code === 'EADDRINUSE') resolve({ ok: false, runningPid: await findHolder(port) });
      else reject(err);
    });
    server.listen(port, '127.0.0.1', () => {
      server.unref(); // holding the lock shouldn't keep the process alive by itself
      resolve({ ok: true });
    });
  });
}

module.exports = { KEEP_ALIVE_PORT, RESTART_EXIT_CODE, findRunningBot, findKeepAlive, takeLock };
