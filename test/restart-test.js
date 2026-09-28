// Simulates the bot restarting in a channel that already has its 5 pinned
// category messages, where every category thread has auto-archived and is
// buried (not in the active list or the most recent 100 archived threads),
// and the anchors sit behind 60 other pins (so finding them needs 2 pages).
const path = require('path');
const BOT_DIR = path.join(__dirname, '..');
process.chdir(BOT_DIR);
process.env.LINK_ARCHIVE_CHANNEL_IDS = '999';
// The test server - set here so the real server list in .env doesn't apply.
process.env.ALLOWED_GUILD_IDS = 'g1';
const discord = require(path.join(BOT_DIR, 'node_modules/discord.js'));
discord.Client.prototype.login = async () => 'stubbed';
const handlers = {};
let botClient;
const origOn = discord.Client.prototype.on;
discord.Client.prototype.on = function (ev, fn) { botClient = this; (handlers[ev] ||= []).push(fn); return origOn.call(this, ev, fn); };
require(path.join(BOT_DIR, 'index.js'));

const everyone = { id: 'everyone' };
const names = ['X Posts', 'TikTok Videos', 'Instagram Posts', 'YouTube Videos', 'News Articles'];
const threads = names.map((name, i) => ({
  id: `anchor${i}`, name, archived: true, posts: [], unarchived: 0,
  send: async function (p) { this.posts.push(p.content); },
  setArchived: async function (v) { this.archived = v; this.unarchived++; },
}));
// 60 unrelated pins (someone else's) come first, then the bot's anchors.
let t = 1_000_000;
const pins = [
  ...Array.from({ length: 60 }, (_, i) => ({ message: { id: `other${i}`, author: { id: 'someone' }, content: `pinned meme ${i}` }, pinnedTimestamp: t-- })),
  ...names.map((name, i) => ({ message: { id: `anchor${i}`, author: { id: 'bot-user' }, content: `📌 **${name}** - every one shared in this server is collected in this message's thread.` }, pinnedTimestamp: t-- })),
];
let pinPages = 0;
let sent = 0;
const channel = {
  id: '999', guildId: 'g1', name: 'links', type: discord.ChannelType.GuildText,
  guild: { name: 'Test Server', members: { me: {} }, roles: { everyone } },
  permissionsFor: () => ({ missing: () => [], has: () => true }),
  send: async () => { sent++; throw new Error('should not post a new anchor'); },
  messages: {
    fetchPins: async ({ before, limit = 50 } = {}) => {
      pinPages++;
      const rest = pins.filter((p) => before === undefined || p.pinnedTimestamp < before);
      return { items: rest.slice(0, limit), hasMore: rest.length > limit };
    },
  },
  threads: {
    fetch: async (id) => threads.find((th) => th.id === id),
    // Buried: neither list includes the category threads.
    fetchActive: async () => ({ threads: new discord.Collection() }),
    fetchArchived: async () => ({ threads: new discord.Collection() }),
  },
};
botClient.user = { id: 'bot-user', tag: 'bot#0001' };
botClient.channels.fetch = async (id) => (id === '999' ? channel : null);

(async () => {
  await handlers.clientReady[0]({ user: botClient.user });
  const msg = {
    id: 'm1', content: 'https://www.tiktok.com/@a/video/1', author: { id: '111', bot: false },
    guildId: 'g1', channelId: 'c5', url: 'https://discord.com/channels/g1/c5/m1',
    guild: { members: { me: {} }, roles: { everyone } }, inGuild: () => true,
    attachments: new discord.Collection(), stickers: new discord.Collection(),
    channel: { id: 'c5', parentId: null, type: discord.ChannelType.GuildText, guild: { roles: { everyone } },
      permissionsFor: () => ({ has: () => true }), send: async () => ({ url: 'https://discord.com/channels/g1/c5/repost' }) },
    delete: async () => {}, reply: async () => ({}), suppressEmbeds: async () => {},
  };
  await handlers.messageCreate[0](msg);
  const tiktok = threads[1];
  const problems = [];
  if (sent) problems.push(`${sent} new anchors posted`);
  if (pinPages < 2) problems.push(`only read ${pinPages} page(s) of pins`);
  if (tiktok.posts.length !== 1) problems.push(`TikTok thread got ${tiktok.posts.length} posts`);
  if (tiktok.unarchived !== 1) problems.push('buried TikTok thread was not reopened');
  console.log(problems.length ? `FAIL: ${problems.join('; ')}` : `ok: restart found all 5 buried threads via pins (${pinPages} pin pages read), no duplicates, TikTok link landed in the existing thread`);
  process.exit(problems.length ? 1 : 0);
})();
