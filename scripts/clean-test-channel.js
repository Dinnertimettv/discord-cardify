// Clears the test posts out of the private #bot-testing channel (TEST_CHANNEL_ID):
// everything the bot posted there and everything posted through webhooks (the
// "Link Tester" test posts and the bot's own reposts). People's messages and
// pinned messages are always left alone.
//   npm run clean:test               shows what would be deleted
//   npm run clean:test -- --delete   deletes it (can't be undone)
require('dotenv').config({ quiet: true });

const API = 'https://discord.com/api/v10';
const { DISCORD_TOKEN, TEST_CHANNEL_ID } = process.env;
const DELETE = process.argv.includes('--delete');
// Discord only bulk-deletes messages younger than 14 days; older ones go one by one.
const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A Discord API call, waiting out rate limits.
async function api(method, path, body) {
  for (;;) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    if (res.status === 429) {
      const { retry_after: wait = 1 } = await res.json().catch(() => ({}));
      await sleep(wait * 1000 + 100);
      continue;
    }
    if (!res.ok) throw new Error(`${method} ${path} failed: HTTP ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  }
}

(async () => {
  if (!DISCORD_TOKEN || !TEST_CHANNEL_ID) {
    console.log('DISCORD_TOKEN and TEST_CHANNEL_ID need to be set in .env.');
    process.exit(1);
  }
  const bot = await api('GET', '/users/@me');
  const channel = await api('GET', `/channels/${TEST_CHANNEL_ID}`);

  const messages = [];
  for (let before = ''; ; ) {
    const page = await api('GET', `/channels/${TEST_CHANNEL_ID}/messages?limit=100${before}`);
    messages.push(...page);
    if (page.length < 100) break;
    before = `&before=${page.at(-1).id}`;
  }
  const isTestPost = (m) => !m.pinned && (m.author.id === bot.id || Boolean(m.webhook_id));
  const doomed = messages.filter(isTestPost);
  const kept = messages.length - doomed.length;

  const byAuthor = {};
  for (const m of doomed) {
    const who = m.webhook_id ? `${m.author.username} (webhook)` : m.author.username;
    byAuthor[who] = (byAuthor[who] ?? 0) + 1;
  }
  console.log(`#${channel.name}: ${messages.length} messages - ${doomed.length} test posts, ${kept} kept (people's messages and pins).`);
  for (const [who, count] of Object.entries(byAuthor)) console.log(`  ${count} from ${who}`);

  if (!DELETE) {
    console.log(doomed.length ? '\nNothing deleted. To delete these, run: npm run clean:test -- --delete' : '\nNothing to delete.');
    return;
  }

  const now = Date.now();
  const recent = doomed.filter((m) => now - Date.parse(m.timestamp) < BULK_DELETE_MAX_AGE_MS).map((m) => m.id);
  const old = doomed.filter((m) => now - Date.parse(m.timestamp) >= BULK_DELETE_MAX_AGE_MS).map((m) => m.id);
  let deleted = 0;
  for (let i = 0; i < recent.length; i += 100) {
    const batch = recent.slice(i, i + 100);
    // Bulk delete takes 2-100 messages; a single one is deleted on its own.
    if (batch.length === 1) await api('DELETE', `/channels/${TEST_CHANNEL_ID}/messages/${batch[0]}`);
    else await api('POST', `/channels/${TEST_CHANNEL_ID}/messages/bulk-delete`, { messages: batch });
    deleted += batch.length;
  }
  for (const id of old) {
    await api('DELETE', `/channels/${TEST_CHANNEL_ID}/messages/${id}`);
    deleted++;
  }
  console.log(`Deleted ${deleted} test posts.`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
