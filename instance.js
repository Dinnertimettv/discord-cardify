// Makes sure only one copy of the bot runs on this PC - two copies would each
// repost and delete every link. The running copy holds a local port as its
// lock: the OS frees the port the moment the process dies, however it dies,
// so the lock can't go stale or be bypassed by deleting a file. Anyone who
// connects to the port is told the running copy's process id.
const net = require('net');

const LOCK_PORT = Number(process.env.BOT_LOCK_PORT) || 47631;

// Resolves to the running bot's process id, or null if it isn't running.
function findRunningBot() {
  return new Promise((resolve) => {
    let reply = '';
    const socket = net.connect(LOCK_PORT, '127.0.0.1');
    socket.setTimeout(2000, () => socket.destroy());
    socket.on('data', (chunk) => {
      reply += chunk;
    });
    socket.on('error', () => resolve(null));
    socket.on('close', () => resolve(Number(reply) || null));
  });
}

// Resolves to { ok: true } once this process holds the lock, or to
// { ok: false, runningPid } if another copy already does.
function takeLock() {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.end(String(process.pid)));
    server.once('error', async (err) => {
      if (err.code === 'EADDRINUSE') resolve({ ok: false, runningPid: await findRunningBot() });
      else reject(err);
    });
    server.listen(LOCK_PORT, '127.0.0.1', () => {
      server.unref(); // holding the lock shouldn't keep the process alive by itself
      resolve({ ok: true });
    });
  });
}

module.exports = { findRunningBot, takeLock };
