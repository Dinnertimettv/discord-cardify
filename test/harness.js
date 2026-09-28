// Loads the bot with Discord login stubbed out, feeds it fake messages and
// button clicks, and validates every outgoing payload against Discord's limits
// (2000-char content, 10 embeds / 6000 embed chars, unique custom_ids, builder
// validation). Selected API URLs are mocked to hit edge cases on demand.
const path = require('path');
const BOT_DIR = path.join(__dirname, '..');
process.chdir(BOT_DIR);
const discord = require(path.join(BOT_DIR, 'node_modules/discord.js'));

// Server 1 -> 999, server 2 -> 888, a second (invalid) channel for server 1, and a bogus id.
process.env.LINK_ARCHIVE_CHANNEL_IDS = '999, 888,777,not-a-channel';
process.env.TEST_WEBHOOK_URL = 'https://discord.com/api/webhooks/555/fake-token';
// Settings go to a temp file, never the real data/settings.json. Server 1
// starts out posting as the bot, so the "shared:" line can be checked; the
// post-as-the-sharer mode is tested further down.
const fs = require('fs');
const os = require('os');
process.env.BOT_SETTINGS_FILE = path.join(os.tmpdir(), `bot-test-settings-${process.pid}.json`);
fs.writeFileSync(process.env.BOT_SETTINGS_FILE, JSON.stringify({ guilds: { g1: { postAsSharer: false } } }));
process.env.BOT_FLAGGED_FILE = path.join(os.tmpdir(), `bot-test-flagged-${process.pid}.json`);
// The bot works in g1 and g2 only (it's also in g3 at startup, which it should leave).
process.env.ALLOWED_GUILD_IDS = ' g1, g2 ';
process.on('exit', () => {
  fs.rmSync(process.env.BOT_SETTINGS_FILE, { force: true });
  fs.rmSync(process.env.BOT_FLAGGED_FILE, { force: true });
});
discord.Client.prototype.login = async () => 'stubbed';
const handlers = {};
let botClient = null;
const origOn = discord.Client.prototype.on;
discord.Client.prototype.on = function (ev, fn) {
  botClient = this;
  (handlers[ev] ||= []).push(fn);
  return origOn.call(this, ev, fn);
};
const everyone = { id: 'everyone-role' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let crashed = [];
process.on('unhandledRejection', (e) => crashed.push(`unhandledRejection: ${e?.stack || e}`));
process.on('uncaughtException', (e) => crashed.push(`uncaughtException: ${e?.stack || e}`));

// ---- fetch mocks for edge cases -----------------------------------------
const realFetch = global.fetch;
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const vid = { videos: [{ url: 'https://video.twimg.com/x.mp4', thumbnail_url: 'https://pbs.twimg.com/x_thumb.jpg', duration: 13.9 }] };
// A YouTube watch page cut down to the parts the bot reads. The title has
// quotes, braces, and asterisks to exercise the JSON reader and escaping.
const ytSummary = '{"videoSummaryContentViewModel":{"paragraphs":[{"videoSummaryParagraphViewModel":{"text":{"content":"Rick promises {never} to give you up."}}},{"videoSummaryParagraphViewModel":{"text":{"content":"Or let you down."}}}]}}';
const ytPage = (id, { family = true, summary = false } = {}) => new Response(`<html><script>var ytInitialPlayerResponse = ${JSON.stringify({
  playabilityStatus: { status: 'OK' },
  videoDetails: {
    videoId: id, title: 'Never "Gonna" {Give} You *Up* [Official]', lengthSeconds: '213', viewCount: '1820758814', author: 'Rick_Astley', isLive: false,
    thumbnail: { thumbnails: [{ url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` }, { url: `https://i.ytimg.com/vi_webp/${id}/maxresdefault.webp` }] },
  },
  microformat: { playerMicroformatRenderer: { publishDate: '2009-10-24T23:57:33-07:00', isFamilySafe: family } },
})};var meta = {};</script><script>var ytInitialData = {"owner":{"videoOwnerRenderer":{"thumbnail":{"thumbnails":[{"url":"https://yt3.ggpht.com/rick=s48-c-k-c0x00ffffff-no-rj"}]}}},"a11y":"like this video along with 19,424,982 other people"${summary ? `,"summary":${ytSummary}` : ''}};</script></html>`);
const mockTweet = (id, extra = {}) => ({
  id, url: `https://x.com/u/status/${id}`, text: 'hi', lang: 'en', likes: 1, reposts: 2, replies: 3,
  author: { name: 'Mock', screen_name: 'mock', avatar_url: 'https://pbs.twimg.com/a.jpg' },
  created_timestamp: 1700000000, ...extra,
});
const MOCKS = {
  '/2/status/9000000000000000001': () => json({ code: 200, status: mockTweet('9000000000000000001', { text: 'A'.repeat(5000), quote: mockTweet('9000000000000000002', { text: 'B'.repeat(3000) }) }) }),
  '/2/status/9000000000000000003': () => json({ code: 200, status: mockTweet('9000000000000000003', { media: vid, quote: mockTweet('9000000000000000004', { media: vid }) }) }),
  '/2/status/9000000000000000005': () => json({ code: 200, status: mockTweet('9000000000000000005', { media: vid, quote: mockTweet('9000000000000000004', { media: vid }) }) }),
  '/2/status/9000000000000000006': () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
  '/2/status/9000000000000000007': () => json({ code: 200, status: mockTweet('9000000000000000007', { quote: { type: 'tombstone', reason: 'deleted' } }) }),
  '/2/status/9000000000000000008': (u) => json({ code: 200, status: mockTweet('9000000000000000008', { lang: 'ja', text: 'こんにちは', media: vid, ...(u.includes('lang=en') ? { translation: { text: 'Hello', source_lang_en: 'Japanese' } } : {}) }) }),
  // The screenshot case: a video post quoting a photo post by the same account.
  '/2/status/9000000000000000009': () => json({ code: 200, status: mockTweet('9000000000000000009', { media: vid, quote: mockTweet('9000000000000000010', { media: { photos: [{ url: 'https://pbs.twimg.com/p.jpg' }] } }) }) }),
  // A text post quoting a sensitive post with three photos.
  '/2/status/9000000000000000013': () => json({ code: 200, status: mockTweet('9000000000000000013', {
    quote: mockTweet('9000000000000000014', { possibly_sensitive: true, media: { all: ['p1', 'p2', 'p3'].map((p) => ({ type: 'photo', url: `https://pbs.twimg.com/${p}.jpg` })) } }),
  }) }),
  // Every styled detail at once: verified, views, app, sensitive photo, reply, Community Note.
  '/2/status/9000000000000000011': () => json({ code: 200, status: mockTweet('9000000000000000011', {
    author: { name: 'Verified_Person', screen_name: 'some_handle', avatar_url: 'https://pbs.twimg.com/a.jpg', verification: { verified: true } },
    likes: 9241, reposts: 1921, replies: 1, views: 306918, source: 'Twitter for iPhone', possibly_sensitive: true,
    replying_to: { screen_name: 'other_user', status: '1' }, community_note: { text: 'Readers note: this is missing context.', facets: [] },
    media: { photos: [{ url: 'https://pbs.twimg.com/s.jpg' }] },
  }) }),
  // An English post, for the server-language translation test (translated only when asked for Spanish).
  '/2/status/9000000000000000012': (u) => json({ code: 200, status: mockTweet('9000000000000000012', { text: 'Hello there', ...(u.includes('lang=es') ? { translation: { text: 'Hola', source_lang_en: 'English' } } : {}) }) }),
  '/2/conversation/': () => json({ code: 200, replies: [mockTweet('11'), { type: 'tombstone' }, mockTweet('12', { media: vid }), mockTweet('13'), mockTweet('14')] }),
  // TikTok and Instagram status feeds (Mastodon-style), a TikTok share link, and 404s for anything else.
  'tnktok.com/api/v1/statuses/7000000000000000001': () => json({
    id: '7000000000000000001', url: 'https://tiktok.com/@creator/video/7000000000000000001', created_at: '2026-09-01T12:00:00.000Z',
    content: 'Funny cat 🐱 <b>❤️ 35.2K 💬 5.7K 🔁 1.5K</b>', sensitive: false,
    account: { username: 'creator', display_name: 'Creator ☑️', avatar: 'https://offload.tnktok.com/generate/pfp/1' },
    media_attachments: [{ type: 'video', url: 'https://offload.tnktok.com/generate/video/7000000000000000001' }],
  }),
  'tnktok.com/api/v1/statuses/7000000000000000002': () => json({
    id: '7000000000000000002', url: 'https://tiktok.com/@creator/photo/7000000000000000002', created_at: '2026-09-01T12:00:00.000Z',
    content: '<b>❤️ 1K 💬 10 🔁 5</b>', sensitive: true,
    account: { username: 'creator', display_name: 'Creator', avatar: 'https://offload.tnktok.com/generate/pfp/1' },
    media_attachments: [1, 2, 3].map((n) => ({ type: 'image', url: `https://offload.tnktok.com/generate/image/7000000000000000002/${n}` })),
  }),
  'tnktok.com/api/v1/statuses/': () => json({ error: 'not found' }, 404),
  'instagramfix.com/api/v1/statuses/MOCKREEL': () => json({
    id: 'MOCKREEL', created_at: '2026-09-02T08:00:00Z', content: '<p>Reel caption &amp; more</p>', sensitive: false,
    account: { username: 'reelmaker', display_name: 'reelmaker', avatar: 'https://instagramfix.com/avatar/reelmaker' },
    media_attachments: [{ type: 'video', url: 'https://instagramfix.com/videos/MOCKREEL/1' }],
  }),
  'instagramfix.com/api/v1/statuses/MOCKCAROUSEL': () => json({
    id: 'MOCKCAROUSEL', created_at: '2026-09-02T08:00:00Z', content: '', sensitive: false,
    account: { username: 'photos', display_name: 'photos', avatar: 'https://instagramfix.com/avatar/photos' },
    media_attachments: [1, 2, 3, 4].map((n) => ({ type: 'image', url: `https://instagramfix.com/images/MOCKCAROUSEL/${n}` })),
  }),
  'instagramfix.com/api/v1/statuses/': () => json({ error: 'not found' }, 404),
  'youtube.com/watch?v=dQw4w9WgXcQ': () => ytPage('dQw4w9WgXcQ', { summary: true }),
  'youtube.com/watch?v=abcdefghijk': () => ytPage('abcdefghijk'),
  'youtube.com/watch?v=agerestrict': () => ytPage('agerestrict', { family: false }),
  // Any other video: a page without the data (like a consent page), so only oEmbed can help.
  'youtube.com/watch?v=': () => new Response('<html>consent</html>'),
  'youtube.com/oembed': (u) => (u.includes('oembedOnly1')
    ? json({ title: 'Just the basics', author_name: 'Some Channel', thumbnail_url: 'https://i.ytimg.com/vi/oembedOnly1/hqdefault.jpg' })
    : new Response('Not Found', { status: 404 })),
  'vm.tiktok.com/ZMmock1': () => new Response(null, { status: 301, headers: { location: 'https://www.tiktok.com/@creator/video/7000000000000000001?_r=1' } }),
  'mock-paywall-article': () => new Response(`<html><head><title>fallback</title><meta name="description" content="x"><meta property="og:title" content="Biden's plan &amp; the &#8220;economy&#8221; &amp;#39;"></head></html>`, { status: 200 }),
};
// Twitch's API answers at one address; the channel/clip/broadcast asked for is in the request body.
const twitchPerson = (login, displayName, isMature = false) =>
  ({ login, displayName, profileImageURL: `https://static-cdn.jtvnw.net/${login}.png`, broadcastSettings: { isMature } });
const mockClip = {
  title: 'Pilot Kill', viewCount: 2037, createdAt: '2026-09-21T18:00:52Z', durationSeconds: 21, thumbnailURL: 'https://static-cdn.jtvnw.net/clip-thumb.jpg',
  curator: { displayName: 'Fan_1' }, game: { name: 'WARDOGS' }, broadcaster: twitchPerson('mocklive', 'MockLive'),
  videoQualities: [1080, 720, 480].map((q) => ({ quality: String(q), sourceURL: `https://clips.cdn.example/${q}/index.mp4` })),
  playbackAccessToken: { signature: 'sig123', value: '{"expires":1}' },
};
const LONG_CLIP_SLUG = `Very${'Long'.repeat(17)}-abc`;
const TWITCH_MOCKS = {
  mocklive: { user: {
    ...twitchPerson('mocklive', 'MockLive'), followers: { totalCount: 50000 },
    stream: { title: 'chill *stream*', viewersCount: 1234, createdAt: '2026-09-27T10:00:00Z', game: { name: 'Just Chatting' }, previewImageURL: 'https://static-cdn.jtvnw.net/previews-ttv/live_user_mocklive-1280x720.jpg' },
    lastBroadcast: { title: 'chill stream', startedAt: '2026-09-27T10:00:00Z', game: { name: 'Just Chatting' } },
  } },
  mockoff: { user: {
    ...twitchPerson('mockoff', '모크'), followers: { totalCount: 1 }, stream: null,
    lastBroadcast: { title: 'old stream', startedAt: '2023-10-15T02:56:52Z', game: { name: 'Halo Infinite' } },
  } },
  1234567890: { video: {
    title: 'Big VOD', lengthSeconds: 9794, viewCount: 212, createdAt: '2026-09-27T18:24:59Z', game: { name: 'WARDOGS' },
    previewThumbnailURL: 'https://static-cdn.jtvnw.net/cf_vods/vod-1280x720.jpg', owner: twitchPerson('mocklive', 'MockLive', true),
  } },
  'MockClipSlug-abc': { clip: mockClip },
  [LONG_CLIP_SLUG]: { clip: mockClip },
};
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u === 'https://gql.twitch.tv/gql') {
    const { variables } = JSON.parse(opts.body);
    return json({ data: TWITCH_MOCKS[variables.id] ?? { user: null, clip: null, video: null } });
  }
  // archive.ph has a snapshot of this one: it redirects (the bot reads the redirect, not the page).
  if (u.startsWith('https://archive.ph/newest/') && u.includes('mock-archived-article')) {
    return new Response(null, { status: 302, headers: { location: 'https://archive.ph/20240101000000/https://www.wsj.com/mock-archived-article' } });
  }
  if (u.includes('archive.ph') && u.includes('mock-paywall-article')) return new Response('nope', { status: 404 });
  for (const [key, fn] of Object.entries(MOCKS)) if (u.includes(key)) return fn(u);
  // Unknown TikTok share codes don't lead anywhere.
  if (/^https:\/\/(vm|vt)\.tiktok\.com\//.test(u)) return new Response(null, { status: 404 });
  return realFetch(url, opts);
};

// ---- payload validation -------------------------------------------------
const TYPE = discord.ComponentType;
const walk = (cs) => cs.flatMap((c) => [c, ...walk(c.components ?? []), ...(c.accessory ? [c.accessory] : [])]);
const textOf = (cs) => walk(cs).filter((c) => c.type === TYPE.TextDisplay).map((c) => c.content).join('\n');
const mediaOf = (cs) => walk(cs).filter((c) => c.type === TYPE.MediaGallery).flatMap((g) => g.items.map((i) => i.media.url));
const cardsOf = (o) => o.components.filter((c) => c.type === TYPE.Container);
const thumbsOf = (cs) => walk(cs).filter((c) => c.type === TYPE.Thumbnail).map((t) => t.media.url);

function validate(payload) {
  if (typeof payload === 'string') payload = { content: payload };
  const problems = [];
  const content = payload.content ?? '';
  if (content.length > 2000) problems.push(`content is ${content.length} chars (>2000)`);
  let embeds = [];
  try { embeds = (payload.embeds || []).map((e) => (e.toJSON ? e.toJSON() : e)); } catch (e) { problems.push(`embed validation: ${e.message}`); }
  if (embeds.length > 10) problems.push(`${embeds.length} embeds (>10)`);
  const total = embeds.reduce((n, e) => n + discord.embedLength(e), 0);
  if (total > 6000) problems.push(`embeds total ${total} chars (>6000)`);
  for (const e of embeds) if ((e.description ?? '').length > 4096) problems.push(`embed description ${e.description.length} chars (>4096)`);
  let components = [];
  try { components = (payload.components || []).map((c) => (c.toJSON ? c.toJSON() : c)); } catch (e) { problems.push(`component validation: ${e.message}`); }
  // Card messages (Components V2): need the flag, can't carry content/embeds,
  // and Discord caps their text at 4000 characters and 40 components.
  const isCard = components.some((c) => c.type !== TYPE.ActionRow);
  const flags = new discord.MessageFlagsBitField(payload.flags ?? 0);
  const all = walk(components);
  if (isCard) {
    if (!flags.has(discord.MessageFlags.IsComponentsV2)) problems.push('card components without the IsComponentsV2 flag');
    if (content || embeds.length) problems.push('card message also has content/embeds (Discord rejects that)');
    const text = textOf(components).length;
    if (text > 4000) problems.push(`card text ${text} chars (>4000)`);
    if (all.length > 40) problems.push(`${all.length} components (>40)`);
  }
  // Link buttons (style 5) open a URL and have no custom_id; they're listed separately.
  const buttons = all.filter((c) => c.type === TYPE.Button);
  const ids = buttons.filter((b) => b.style !== discord.ButtonStyle.Link).map((b) => b.custom_id);
  const links = buttons.filter((b) => b.style === discord.ButtonStyle.Link).map((b) => `${b.label} -> ${b.url}`);
  for (const b of buttons) if (b.style === discord.ButtonStyle.Link && !/^https?:\/\//.test(b.url ?? '')) problems.push(`link button without a URL: ${b.label}`);
  if (buttons.length > 25) problems.push(`${buttons.length} buttons (>25)`);
  for (const id of ids) if (id.length > 100) problems.push(`custom_id over 100 chars: ${id.slice(0, 40)}...`);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length) problems.push(`duplicate custom_ids: ${dupes.join(', ')}`);
  return {
    content, embeds, embedChars: total, components, isCard, buttons: ids, links, flags: payload.flags, problems,
    username: payload.username, avatarURL: payload.avatarURL, threadId: payload.threadId,
  };
}

// Webhooks the fake channels hand out, so tests can inspect or break them.
const fakeWebhooks = [];
let currentOut = null; // output list of the message being handled right now
function fakeMessage(content, opts = {}) {
  const { guild = true, canManage = true, attachments = 0 } = opts;
  const out = [];
  currentOut = out;
  const channelId = opts.channelId ?? 'c1';
  const guildObj = guild ? { members: { me: {} }, roles: { everyone } } : undefined;
  const makeChannel = (id, type) => ({
    id, type, guild: guildObj,
    permissionsFor: (who) => ({ has: () => (who === everyone ? opts.public ?? true : canManage) }),
    send: async (p) => { out.push(validate(p)); return { url: `https://discord.com/channels/g1/${id}/repost` }; },
    isThread: () => [discord.ChannelType.PublicThread, discord.ChannelType.PrivateThread].includes(type),
    // The bot's webhook: posts are recorded along with the name/avatar they went out under.
    fetchWebhooks: async () => new discord.Collection(fakeWebhooks.filter((w) => w.channelId === id).map((w) => [w.id, w])),
    createWebhook: async ({ name }) => {
      const hook = { id: `wh-${fakeWebhooks.length}`, channelId: id, name, token: 'tok', owner: { id: 'bot-user' }, broken: false };
      hook.send = async (p) => {
        if (hook.broken) throw Object.assign(new Error('Unknown Webhook'), { code: 10015 });
        currentOut.push({ ...validate(p), viaWebhook: true });
        return { url: `https://discord.com/channels/g1/${id}/webhook-post` };
      };
      fakeWebhooks.push(hook);
      return hook;
    },
  });
  const channel = makeChannel(channelId, opts.channelType ?? discord.ChannelType.GuildText);
  channel.parentId = opts.parentId ?? null;
  if (opts.parentId) channel.parent = makeChannel(opts.parentId, discord.ChannelType.GuildText);
  channel.guild = guildObj;
  const author = {
    id: opts.webhookId ?? '111111111111111111', bot: Boolean(opts.bot), username: 'alex', displayName: 'Alex',
    displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/111/abc.png',
  };
  return {
    id: 'm1', content, author, webhookId: opts.webhookId ?? null,
    member: guild ? { displayName: 'Alex (server nickname)', displayAvatarURL: () => 'https://cdn.discordapp.com/guilds/g1/users/111/avatars/def.png' } : null,
    guildId: guild ? opts.guildId ?? 'g1' : null, channelId, url: `https://discord.com/channels/g1/${channelId}/m1`,
    guild: channel.guild ?? null, channel, inGuild: () => guild,
    attachments: new discord.Collection(Array.from({ length: attachments }, (_, i) => [String(i), {}])),
    stickers: new discord.Collection(),
    delete: async () => out.push('(original deleted)'),
    reply: async (p) => { out.push({ ...validate(p), isReply: true }); return {}; },
    suppressEmbeds: async () => out.push('(original embeds suppressed)'),
    out,
  };
}

function describeCard(components) {
  return components.map((c) => {
    if (c.type === TYPE.ActionRow) return null;
    if (c.type === TYPE.Separator) return '      ~ gap ~';
    if (c.type === TYPE.TextDisplay) return c.content.split('\n').map((l) => `      | ${l.slice(0, 100)}`).join('\n');
    const media = mediaOf([c]).map((u) => (/video/.test(u) ? 'video' : 'photo'));
    const first = textOf([c]).split('\n')[0].slice(0, 70);
    return `      [card #${(c.accent_color ?? 0).toString(16).padStart(6, '0')}] ${first}${media.length ? ` + ${media.join(', ')}` : ''}${walk([c]).some((x) => x.type === TYPE.Thumbnail) ? ' + avatar' : ''}`;
  }).filter(Boolean).join('\n');
}

function describe(o) {
  if (typeof o === 'string') return `   ${o}`;
  let s = `   ${o.isReply ? 'reply' : o.viaWebhook ? `as "${o.username}"` : 'sent'}: ${o.isCard ? 'CARD' : `${o.content.length} chars, ${o.embeds.length} embeds (${o.embedChars} chars)`}` +
    (o.buttons.length ? `, buttons=[${o.buttons.join(' | ')}]` : '') + (o.links?.length ? `, links=[${o.links.map((l) => l.split(' -> ')[0]).join(' | ')}]` : '');
  if (o.content) s += '\n' + o.content.split('\n').map((l) => `      | ${l.length > 110 ? l.slice(0, 110) + '…' : l}`).join('\n');
  if (o.isCard) s += '\n' + describeCard(o.components);
  for (const e of o.embeds) s += `\n      [embed] ${(e.author?.name ?? '').slice(0, 40)} | desc=${(e.description ?? '').length} chars${e.fields?.length ? ` | fields: ${e.fields.map((f) => f.name).join('; ')}` : ''}${e.image ? ' | image' : ''}`;
  for (const p of o.problems) s += `\n   PROBLEM: ${p}`;
  return s;
}

let failures = 0;
async function run(label, content, opts, check) {
  crashed = [];
  const msg = fakeMessage(content, opts);
  let threw = null;
  try { await handlers.messageCreate[0](msg); } catch (e) { threw = e; }
  await new Promise((r) => setTimeout(r, 30));
  const checkErr = check ? check(msg.out.filter((o) => typeof o !== 'string')) : null;
  const bad = threw || crashed.length || msg.out.some((o) => o.problems?.length) || checkErr;
  if (bad) failures++;
  console.log(`\n=== ${bad ? 'FAIL' : 'ok  '} ${label}`);
  if (threw) console.log('  handler threw:', threw.message);
  if (checkErr) console.log('  CHECK FAILED:', checkErr);
  for (const c of crashed) console.log('  ', c.split('\n')[0]);
  for (const o of msg.out) console.log(describe(o));
  const sent = msg.out.filter((o) => typeof o !== 'string');
  // Invariant: Discord won't preview links in a message that has bot-built embeds.
  for (const o of sent) {
    if (o.embeds.length && /(?<!<)https?:\/\//.test(o.content)) { failures++; console.log('   PROBLEM: links + bot embeds in one message (link previews will be suppressed)'); }
  }
  if (sent[0]) sent[0].all = sent;
  return sent[0];
}

// voiceChannel: the voice channel whoever clicked is in (for Watch Together).
function fakeInteraction(customId, sent, { userId = '222222222222222222', isMod = false, inGuild = true, voiceChannel = null } = {}) {
  const log = [];
  const guild = inGuild
    ? { members: { me: {} }, voiceStates: { cache: new Map(voiceChannel ? [[userId, { channel: voiceChannel }]] : []) } }
    : null;
  const thread = { send: async (p) => log.push(['thread.send', validate(p)]) };
  const message = {
    id: sent.id ?? 'clicked-message',
    content: sent.content ?? '',
    embeds: sent.embeds ?? [], // raw API JSON, like Discord returns
    components: sent.components,
    thread: null, hasThread: false,
    channel: { threads: { fetch: async () => thread } },
    startThread: async ({ name, autoArchiveDuration }) => { log.push(`startThread("${name}", ${autoArchiveDuration})`); return thread; },
    edit: async (p) => { log.push(['message.edit', validate(p)]); },
  };
  const i = {
    customId, user: { id: userId, tag: 'clicker#0001' }, inGuild: () => inGuild, guild, memberPermissions: { has: () => isMod },
    message, deferred: false, replied: false, isButton: () => true,
    deferReply: async (o) => { i.deferred = true; log.push(`deferReply(flags=${o?.flags})`); },
    deferUpdate: async () => { i.deferred = true; log.push('deferUpdate'); },
    isChatInputCommand: () => false,
    editReply: async (p) => log.push(['editReply', validate(p)]),
    reply: async (p) => { i.replied = true; log.push(['reply', validate(p)]); },
    followUp: async (p) => log.push(['followUp', validate(p)]),
    update: async (p) => { i.replied = true; log.push(['update', validate(p)]); },
  };
  return { i, log };
}

async function click(label, customId, sent, opts, check) {
  crashed = [];
  const { i, log } = fakeInteraction(customId, sent, opts);
  let threw = null;
  try { await handlers.interactionCreate[0](i); } catch (e) { threw = e; }
  await new Promise((r) => setTimeout(r, 30));
  const checkErr = check ? check(log) : null;
  const bad = threw || crashed.length || log.some((l) => Array.isArray(l) && l[1].problems.length) || checkErr;
  if (bad) failures++;
  console.log(`\n=== ${bad ? 'FAIL' : 'ok  '} [button] ${label}`);
  if (threw) console.log('  handler threw:', threw.message);
  if (checkErr) console.log('  CHECK FAILED:', checkErr);
  for (const c of crashed) console.log('  ', c.split('\n')[0]);
  for (const l of log) console.log(Array.isArray(l) ? `   ${l[0]} ->${describe(l[1]).replace(/^ +\w+:/, '')}` : `   ${l}`);
  return log;
}

(async () => {
  require(path.join(BOT_DIR, 'index.js'));
  botClient.user = { id: 'bot-user', tag: 'bot#0001', username: 'Old Bot Name', displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/bot.png' };
  const has = (s, sub) => (s.includes(sub) ? null : `expected content to include ${JSON.stringify(sub)}`);
  const lacks = (s, sub) => (s.includes(sub) ? `expected content NOT to include ${JSON.stringify(sub)}` : null);
  const POSTER = '111111111111111111';

  // --- X posts: one card message each; a quoted post sits inside the quoting post's card ---
  const plain = await run('real tweet -> one card message with header, avatar, buttons', 'look https://x.com/jack/status/20', {}, (out) => {
    const [o] = out;
    if (out.length !== 1 || !o.isCard) return 'expected exactly one card message';
    if (!o.components[0].content?.startsWith(`<@${POSTER}> shared:\n> look`)) return 'header missing from the card';
    const [card] = cardsOf(o);
    if (card.accent_color !== 0x0b5cad) return `card color ${card.accent_color}`;
    if (!textOf([card]).includes('just setting up my twttr')) return 'post text missing';
    if (!walk([card]).some((c) => c.type === TYPE.Thumbnail)) return 'avatar missing';
    return o.buttons.join() === `copy-x:jack:20,top-replies:20,flag-card:20:${POSTER}` ? null : `buttons ${o.buttons}`;
  });
  await run('nonexistent tweet (fxtwitter 404) -> fallback link, no crash', 'https://x.com/nobody/status/1', {}, ([o]) => has(o.content, 'fxtwitter.com/nobody/status/1'));
  await run('fxtwitter returns HTML 502 -> fallback link', 'https://x.com/u/status/9000000000000000006', {}, ([o]) => has(o.content, 'status/9000000000000000006'));
  await run('long post quoting a long post -> ONE card, quote inside, fits the text limit', 'https://x.com/u/status/9000000000000000001', {}, ([o]) => {
    const order = o.components.map((c) => c.type).join(',');
    if (order !== [TYPE.TextDisplay, TYPE.Container, TYPE.ActionRow].join(',')) return `layout ${order}`;
    const text = textOf(cardsOf(o));
    if (!text.startsWith('### [𝕏  ·  Post](https://x.com/u/status/9000000000000000001)')) return 'header: ' + text.split('\n')[0];
    const quoteAt = text.indexOf('### [↪ Quoting](');
    if (quoteAt < 0 || text.indexOf('AAAA') > quoteAt || text.indexOf('>>> BBBB') < quoteAt) return 'the shared post should come first, its quote inside the card after it';
    if (!/\n\*\*A+…\*\*\n/.test(text)) return 'the cut-off post text should stay bold, closing ** intact';
    return null;
  });
  await run('two video posts quoting the same video -> two cards, both videos play in each', 'https://x.com/u/status/9000000000000000003 https://x.com/u/status/9000000000000000005', {}, (out) => {
    if (out.length !== 2 || !out.every((o) => o.isCard)) return `${out.length} messages`;
    if (out.some((o) => mediaOf(o.components).filter((u) => u.includes('video.twimg.com')).length !== 2)) return 'both videos should be in each card';
    if (out.some((o) => thumbsOf(o.components).some((u) => u !== 'https://pbs.twimg.com/a.jpg'))) return 'only profile pictures belong on the right';
    return out[1].components[0].type === TYPE.Container ? null : 'header should only be on the first card';
  });
  await run('quote with 3 sensitive photos -> quote author\'s avatar on the right, the photos blurred in a gallery under the quote', 'https://x.com/u/status/9000000000000000013', {}, ([o]) => {
    const galleries = walk(cardsOf(o)).filter((c) => c.type === TYPE.MediaGallery);
    if (galleries.length !== 1 || galleries[0].items.map((i) => i.media.url).join() !== ['p1', 'p2', 'p3'].map((p) => `https://pbs.twimg.com/${p}.jpg`).join()) return 'the quoted photos should be one gallery';
    if (!galleries[0].items.every((i) => i.spoiler) || !textOf(cardsOf(o)).includes('⚠️ Marked sensitive by X')) return 'the quoted photos should be blurred';
    const text = textOf(cardsOf(o));
    if (text.indexOf('>>> hi') > text.indexOf('⚠️ Marked sensitive')) return 'the photos should come after the quoted text';
    return thumbsOf(o.components).every((u) => u === 'https://pbs.twimg.com/a.jpg') ? null : `thumbnails ${thumbsOf(o.components)}`;
  });
  await run('tombstoned quote -> "unavailable" note inside the card', 'https://x.com/u/status/9000000000000000007', {}, ([o]) =>
    cardsOf(o).length === 1 && textOf(cardsOf(o)).includes('### ↪ Quoting\n*The quoted post is unavailable') ? null : textOf(cardsOf(o)));
  await run('non-English video post -> translation + video in the card', 'https://x.com/u/status/9000000000000000008', {}, ([o]) => {
    const text = textOf(o.components);
    return text.includes('🌐 Translated from Japanese') && text.includes('Hello') && mediaOf(o.components).length === 1 ? null : text;
  });
  await run('trailing period + tracking + angle brackets', 'wow <https://x.com/jack/status/20?s=20>.', {}, ([o]) => lacks(o.components[0].content, '<>'));
  await run('paywall: apostrophe/entities in title, sentence-final period', 'read https://www.nytimes.com/mock-paywall-article.', {},
    ([o]) => has(o.content, "**Biden's plan & the “economy” &#39;**") || lacks(o.content, 'article.'));
  await run('paywall article with an archive.ph snapshot -> original link + archived copy', 'https://www.wsj.com/mock-archived-article', {}, ([o]) =>
    has(o.content, 'https://www.wsj.com/mock-archived-article\nArchived copy: <https://archive.ph/20240101000000/https://www.wsj.com/mock-archived-article>') || lacks(o.content, 'Bypass attempt'));
  await run('paywall lookalike domain ignored', 'https://nytimes.com.evil.example/x https://notnytimes.com/x', {}, (out) => (out.length ? 'should not post' : null));
  await run('huge commentary (nitro-length) + link -> header in plain messages, then the card', `${'long text '.repeat(380)} https://x.com/jack/status/20`, {},
    (out) => (out.length >= 2 && !out[0].isCard && out.at(-1).isCard && !textOf(out.at(-1).components).includes('long text') ? null : `${out.length} messages`));
  await run('DM, no manage perms -> card as a reply', 'https://x.com/jack/status/20', { guild: false, canManage: false }, ([o]) => (o.isReply && o.isCard ? null : 'expected card reply'));
  await run('has attachment -> reply + suppress, not delete', 'https://x.com/jack/status/20', { attachments: 1 });
  await run('in a thread -> no reply-thread button', 'https://x.com/jack/status/20', { channelType: discord.ChannelType.PublicThread },
    ([o]) => (o.buttons.some((b) => b.startsWith('top-replies')) ? 'thread button shown' : null));
  await run('two tweets, long username in URL -> short custom ids (real handle)', `https://x.com/${'a'.repeat(90)}/status/20 https://x.com/u/status/9000000000000000007`, {},
    (out) => (out.length === 2 && out[0].buttons[0] === 'copy-x:jack:20' ? null : `${out.length} messages`));
  await run('tiktok/instagram with tracking junk; reddit now ignored',
    'https://vm.tiktok.com/ZMabc123/?is_from_webapp=1 https://www.instagram.com/reel/Cxyz/?igsh=abc. https://www.reddit.com/r/pics/comments/abc123/title/?utm_source=share',
    {}, ([o]) => has(o.content, 'https://tnktok.com/ZMabc123/') || has(o.content, 'https://instagramfix.com/reel/Cxyz/') || lacks(o.content, 'rxddit') || has(o.content, '> https://www.reddit.com/r/pics/comments/abc123/title/?utm_source=share'));
  await run('reddit-only message -> ignored', 'https://www.reddit.com/r/pics/comments/abc123/title/ https://redd.it/abc', {}, (out) => (out.length ? 'should not post' : null));
  // New paywall domains: subdomains, co.uk/com.au TLDs, and lookalikes that must NOT match.
  global.fetch = ((prev) => async (url, opts) => (/archive\.ph|cnn|thetimes|nikkei|smh|spiegel|ajc|theverge/.test(String(url)) ? new Response('<title>Headline</title>', { status: 404 }) : prev(url, opts)))(global.fetch);
  await run('new paywall domains match (incl. subdomains)',
    'https://edition.cnn.com/2026/a https://www.thetimes.com/b https://asia.nikkei.com/c https://www.smh.com.au/d https://www.spiegel.de/e',
    {}, ([o]) => ['https://edition.cnn.com/2026/a', 'https://www.thetimes.com/b', 'https://asia.nikkei.com/c', 'https://www.smh.com.au/d', 'https://www.spiegel.de/e'].map((u) => has(o.content, u)).find(Boolean) ?? null);
  await run('paywall lookalikes do not match', 'https://notcnn.com/x https://ajc.com.fake.example/x https://mytheverge.com/x https://thestar.com.my/x', {}, (out) => (out.length ? 'should not post' : null));
  await run('no links -> ignored', 'just chatting', {}, (out) => (out.length ? 'should not post' : null));

  const shot = await run('video post quoting a photo post -> ONE card: its video, then the quote with its photo in a gallery (not where the avatar goes)', 'https://x.com/DropSiteNews/status/9000000000000000009', {}, (out) => {
    if (out.length !== 1 || !out[0].isCard || cardsOf(out[0]).length !== 1) return `${out.length} messages`;
    if (!mediaOf(out[0].components).some((u) => u.includes('video.twimg.com'))) return "the post's video is missing";
    if (!mediaOf(out[0].components).includes('https://pbs.twimg.com/p.jpg') || thumbsOf(out[0].components).includes('https://pbs.twimg.com/p.jpg')) return 'the quoted photo should be in a gallery, not a thumbnail';
    return out[0].buttons.join() === `copy-x:mock:9000000000000000009,top-replies:9000000000000000009,flag-card:9000000000000000009:${POSTER}` ? null : `buttons ${out[0].buttons}`;
  });
  await run('commentary with another website\'s link + X post -> comment gets its own plain message', 'lol https://example.com/page https://x.com/jack/status/20', {}, (out) =>
    out.length === 2 && out[0].content.includes('example.com/page') && !out[0].isCard && !out[0].buttons.length && out[1].isCard && out[1].components[0].type === TYPE.Container ? null : `${out.length} messages`);
  const mixed = await run('mixed links -> plain link message + one card per post (YouTube, X, X)', 'lol https://youtu.be/dQw4w9WgXcQ https://vm.tiktok.com/ZMabc/?x=1 https://www.instagram.com/reel/Cxyz/ https://www.nytimes.com/mock-paywall-article https://x.com/jack/status/20 https://x.com/u/status/9000000000000000008', {},
    (out) => (out.length === 4 && !out[0].isCard && out[0].buttons[0] === 'copy-links' && !out[0].content.includes('youtu') && out.slice(1).every((o) => o.isCard) ? null : `${out.length} messages`));

  // --- buttons on the new cards ---
  console.log('\n----- buttons on X post cards -----');
  const copyCheck = (expected) => (log) => {
    const r = log[0]?.[1];
    if (log[0]?.[0] !== 'reply') return 'no reply';
    const flags = new discord.MessageFlagsBitField(r.flags);
    if (!flags.has(discord.MessageFlags.Ephemeral) || !flags.has(discord.MessageFlags.SuppressEmbeds)) return `flags=${flags.toArray()}`;
    return r.content === expected.join('\n') ? null : `got ${JSON.stringify(r.content)}`;
  };
  await click('copy link on a card', 'copy-x:jack:20', plain, {}, copyCheck(['https://fxtwitter.com/jack/status/20']));
  await click('flag card (not poster, not mod) -> denied', `flag-card:20:${POSTER}`, plain, {},
    (log) => (log[0]?.[0] === 'reply' && log[0][1].flags === 64 ? null : 'expected ephemeral denial'));
  const cardFlagLog = await click('flag card as mod -> both posts hidden, header kept, Reveal + Undo flag buttons', `flag-card:9000000000000000009:${POSTER}`, shot, { isMod: true }, (log) => {
    const u = log.find((l) => l[0] === 'update')?.[1];
    if (!u?.isCard) return 'no card update';
    if (mediaOf(u.components).length) return 'media still visible';
    const text = textOf(u.components);
    if (!text.startsWith(`<@${POSTER}> shared:`) || !text.includes('Flagged as NSFW') || text.includes('Quoted by')) return text;
    if (u.buttons.join() !== `copy-x:mock:9000000000000000009,top-replies:9000000000000000009,reveal-card:9000000000000000009,unflag-card:${POSTER}`) return `buttons ${u.buttons}`;
    return log.some((l) => l[0] === 'followUp') ? null : 'no confirmation';
  });
  const flaggedShot = cardFlagLog.find((l) => l[0] === 'update')[1];
  await click('undo flag (not poster, not mod) -> denied', `unflag-card:${POSTER}`, flaggedShot, {}, (log) =>
    (log[0]?.[0] === 'reply' && log[0][1].flags === 64 && log[0][1].content.includes('undo the flag') && !log.some((l) => l[0] === 'update') ? null : 'expected ephemeral denial'));
  await click('undo flag as the person who shared it -> the card is back exactly as it was', `unflag-card:${POSTER}`, flaggedShot, { userId: POSTER }, (log) => {
    const u = log.find((l) => l[0] === 'update')?.[1];
    if (!u?.isCard) return 'no card update';
    if (JSON.stringify(u.components) !== JSON.stringify(shot.components.map((c) => c.toJSON?.() ?? c))) return `not the original card: ${textOf(u.components)}`;
    return log.some((l) => l[0] === 'followUp') ? null : 'no confirmation';
  });
  await click('undo flag again (already undone) -> says so, nothing changed', `unflag-card:${POSTER}`, flaggedShot, { userId: POSTER }, (log) =>
    (!log.some((l) => l[0] === 'update') && log[0]?.[1]?.content?.includes("Couldn't find") ? null : 'expected a private message'));
  await click('undo flag on a full row of buttons -> Reveal + Undo re-packed into rows of 5', `flag-card:1:${POSTER}`, {
    components: [{ type: TYPE.Container, components: [{ type: TYPE.TextDisplay, content: 'card' }] },
      { type: TYPE.ActionRow, components: ['a', 'b', 'c', 'd', `flag-card:1:${POSTER}`].map((id) => ({ type: TYPE.Button, style: 2, custom_id: id, label: id })) }],
  }, { isMod: true }, (log) => {
    const rows = log.find((l) => l[0] === 'update')?.[1].components.filter((c) => c.type === TYPE.ActionRow) ?? [];
    return rows.map((r) => r.components.length).join() === '5,1' ? null : `rows ${rows.map((r) => r.components.length)}`;
  });
  await click('flag card with no header (reply-path card) as original poster', `flag-card:20:${POSTER}`, { components: plain.components.slice(1) }, { userId: POSTER },
    (log) => (log.find((l) => l[0] === 'update')?.[1].components[0].type === TYPE.Container ? null : 'expected the notice first'));
  await click('reveal flagged card -> private card with both posts', 'reveal-card:9000000000000000009', shot, {}, (log) => {
    const r = log.find((l) => l[0] === 'editReply')?.[1];
    return r?.isCard && mediaOf(r.components).length === 2 && mediaOf(r.components).includes('https://pbs.twimg.com/p.jpg') && log[0] === `deferReply(flags=${discord.MessageFlags.Ephemeral})` ? null : 'no private card';
  });
  await click('reveal a deleted post -> friendly error', 'reveal-card:1', plain, {}, (log) =>
    log.at(-1)?.[0] === 'editReply' && log.at(-1)[1].content.includes("Couldn't") ? null : 'no error reply');
  await click('top replies on a card -> thread, card kept, button disabled, private status', 'top-replies:20', plain, {}, (log) => {
    // deferUpdate, then editReply edits the clicked message itself (works for webhook posts too).
    const edit = log.find((l) => l[0] === 'editReply')?.[1];
    const button = edit && walk(edit.components).find((c) => c.custom_id === 'top-replies:20');
    const status = log.find((l) => l[0] === 'followUp')?.[1];
    if (log[0] !== 'deferUpdate') return `acknowledged with ${log[0]}`;
    if (log.filter((l) => l[0] === 'thread.send').length !== 3) return 'expected 3 replies in the thread';
    if (!(edit?.isCard && cardsOf(edit).length === 1 && button?.disabled)) return 'card not kept or button not disabled';
    return status?.flags === discord.MessageFlags.Ephemeral && status.content.includes('Posted the top 3') ? null : 'no private status message';
  });

  // --- buttons on messages from older versions of the bot ---
  console.log('\n----- buttons on older messages -----');
  const row = (...ids) => new discord.ActionRowBuilder().addComponents(ids.map((id) => new discord.ButtonBuilder().setCustomId(id).setLabel('x').setStyle(2))).toJSON();
  const oldEmbedMsg = {
    content: `<@${POSTER}> shared:`,
    embeds: [
      { type: 'rich', author: { name: 'jack (@jack)', url: 'https://x.com/jack/status/20' }, description: 'just setting up my twttr', image: { url: 'https://pbs.twimg.com/x.jpg' } },
      { type: 'rich', author: { name: '↪ Quoted post • Mock (@mock)', url: 'https://x.com/u/status/9000000000000000002' }, description: 'quoted' },
    ],
    components: [row('copy-links', 'top-replies:20', `flag-nsfw:x:20:0:${POSTER}`)],
  };
  const oldVideoMsg = {
    content: `<@${POSTER}> shared:\nhttps://fxtwitter.com/u/status/9000000000000000003\n**↪ Quoted post:** https://fxtwitter.com/mock/status/9000000000000000004\nhttps://fxtwitter.com/u/status/9000000000000000005\n**↪ Quoted post:** https://fxtwitter.com/mock/status/9000000000000000004`,
    embeds: [],
    components: [row('copy-links', `flag-nsfw-link:x:9000000000000000003:${POSTER}`, `flag-nsfw-link:x:9000000000000000004:${POSTER}`)],
  };
  const flagLinkId = `flag-nsfw-link:x:9000000000000000004:${POSTER}`;
  await click('old: flag video link (not poster, not mod) -> denied', flagLinkId, oldVideoMsg, {},
    (log) => (log[0]?.[0] === 'reply' && log[0][1].flags === 64 ? null : 'expected ephemeral denial'));
  await click('old: flag video link as original poster -> both copies hidden', flagLinkId, oldVideoMsg, { userId: POSTER }, (log) => {
    const u = log.find((l) => l[0] === 'update')?.[1];
    if (!u) return 'no update';
    return (u.content.match(/<https:\/\/fxtwitter\.com\/mock\/status\/9000000000000000004>/g) || []).length === 2 ? null : 'expected 2 hidden links';
  });
  const prefixMsg = { content: '<@1> shared:\nhttps://fxtwitter.com/a/status/12\nhttps://fxtwitter.com/b/status/123/en', components: [row('flag-nsfw-link:x:12:1')], embeds: [] };
  await click('old: flag id 12 must not hide /status/123', 'flag-nsfw-link:x:12:1', prefixMsg, { isMod: true }, (log) => {
    const u = log.find((l) => l[0] === 'update')?.[1];
    return u && u.content.includes('<https://fxtwitter.com/a/status/12>') && u.content.includes('\nhttps://fxtwitter.com/b/status/123/en') ? null : 'wrong link hidden';
  });
  await click('old: flag embed as mod', `flag-nsfw:x:20:0:${POSTER}`, oldEmbedMsg, { isMod: true }, (log) => {
    const u = log.find((l) => l[0] === 'update')?.[1];
    return u && u.embeds[0].description.includes('hidden') && !u.embeds[0].image && u.buttons.includes('reveal-nsfw:x:20:0') ? null : 'embed not hidden';
  });
  await click('old: reveal hidden embed', 'reveal-nsfw:x:20:0', oldEmbedMsg);
  await click('old: reveal button without an index', 'reveal-nsfw:x:20', oldEmbedMsg);
  await click('old: reveal video link', 'reveal-nsfw-link:x:9000000000000000004', oldVideoMsg, {}, (log) =>
    log[0]?.[1]?.content.includes('https://fxtwitter.com/i/status/9000000000000000004') ? null : 'wrong link');
  await click('old: copy on an embed post -> fxtwitter link, quoted post left out', 'copy-links', oldEmbedMsg, {}, copyCheck(['https://fxtwitter.com/jack/status/20']));
  await click('old: copy on video links -> quote lines left out', 'copy-links', oldVideoMsg, {}, copyCheck(['https://fxtwitter.com/u/status/9000000000000000003', 'https://fxtwitter.com/u/status/9000000000000000005']));
  const flaggedLog = await click('(old: flag a video first)', `flag-nsfw-link:x:9000000000000000003:${POSTER}`, oldVideoMsg, { isMod: true });
  const flaggedMsg = { ...oldVideoMsg, content: flaggedLog.find((l) => l[0] === 'update')[1].content };
  await click('old: copy still works after a video was NSFW-flagged', 'copy-links', flaggedMsg, {}, copyCheck(['https://fxtwitter.com/u/status/9000000000000000003', 'https://fxtwitter.com/u/status/9000000000000000005']));
  await click('copy (links message): fixed links, original article excluded', 'copy-links', mixed, {}, copyCheck([
    'https://tnktok.com/ZMabc/', 'https://instagramfix.com/reel/Cxyz/',
    'https://www.removepaywall.com/search?url=https%3A%2F%2Fwww.nytimes.com%2Fmock-paywall-article',
  ]));
  await click('old: copy on a message with a tiktokfix.com link (previous fixer) still works', 'copy-links',
    { content: `<@${POSTER}> shared:\nhttps://tiktokfix.com/@a/video/1`, embeds: [], components: [row('copy-links')] }, {},
    copyCheck(['https://tiktokfix.com/@a/video/1']));
  await click('copy: message with no links -> friendly note', 'copy-links', { content: 'hi', embeds: [], components: [] }, {}, (log) =>
    log[0]?.[1]?.content.includes("Couldn't find") ? null : 'no note');
  await click('removed top-comments button -> ignored', 'top-comments:abc12', oldEmbedMsg, {}, (log) => (log.length ? 'should ignore' : null));
  await click('unrelated button id ignored', 'someone-elses-button', oldEmbedMsg, {}, (log) => (log.length ? 'should ignore' : null));

  // --- card style: header, badges, stats bar, links, sensitive media, Community Notes ---
  console.log('\n----- card style -----');
  await run('X card: header, no check mark, stats bar, app, blurred media, note, "Open on X"', 'https://x.com/some_handle/status/9000000000000000011', {}, ([o]) => {
    const [card, note] = cardsOf(o);
    const text = textOf([card]);
    const gallery = walk([card]).find((c) => c.type === TYPE.MediaGallery);
    if (!text.startsWith('### [𝕏  ·  Replying to @other\\_user](https://x.com/u/status/9000000000000000011)')) return `header: ${text.split('\n')[0]}`;
    if (!text.includes('**Verified\\_Person** @some\\_handle')) return `name line: ${text.split('\n')[1]}`;
    if (!text.includes('**1** Reply   **1.9K** Reposts   **9.2K** Likes   **306.9K** Views')) return `stats: ${text}`;
    if (!text.includes('-# <t:1700000000:R>  ·  Twitter for iPhone')) return 'missing relative time / app';
    if (!gallery?.items.every((i) => i.spoiler) || !text.includes('⚠️ Marked sensitive by X')) return 'sensitive media not blurred';
    if (!walk([card]).some((c) => c.type === TYPE.Separator && c.divider)) return 'no divider above the stats';
    if (note?.accent_color !== 0xf2b705 || !textOf([note]).includes('Readers added context')) return 'no Community Note box';
    return o.links.join() === 'Open on 𝕏 -> https://x.com/u/status/9000000000000000011' ? null : `links: ${o.links}`;
  });
  await run('X quote card: same-size linked headings, the post\'s text bold and its quote\'s regular, no numbering, "Open quoted post" button', 'https://x.com/DropSiteNews/status/9000000000000000009', {}, ([o]) => {
    const text = textOf(cardsOf(o));
    if (
      !text.startsWith('### [𝕏  ·  Post](https://x.com/u/status/9000000000000000009)\n**Mock** @mock\n**hi**\n') ||
      !text.includes('\n### [↪ Quoting](https://x.com/u/status/9000000000000000010)\n**Mock** @mock\n>>> hi') ||
      text.includes('of 2')
    ) return 'headings: ' + text;
    return o.links.join('|') === 'Open on 𝕏 -> https://x.com/u/status/9000000000000000009|Open quoted post -> https://x.com/u/status/9000000000000000010' ? null : `links: ${o.links}`;
  });

  // --- TikTok and Instagram cards ---
  console.log('\n----- TikTok & Instagram cards -----');
  await run('TikTok share link -> resolved, video card with stats', 'lol https://vm.tiktok.com/ZMmock1/?x=1', {}, ([o]) => {
    const [card] = cardsOf(o);
    const text = textOf([card]);
    if (card?.accent_color !== 0xfe2c55) return 'not a TikTok card';
    if (!text.startsWith('### [🎵 TikTok  ·  Video](https://tiktok.com/@creator/video/7000000000000000001)') || !text.includes('**Creator** @creator') || !text.includes('Funny cat 🐱')) return text;
    if (!text.includes('**35.2K** Likes   **5.7K** Comments   **1.5K** Shares')) return `stats: ${text}`;
    if (!mediaOf([card]).includes('https://offload.tnktok.com/generate/video/7000000000000000001')) return 'video missing';
    if (o.links.join() !== 'Open on TikTok -> https://tiktok.com/@creator/video/7000000000000000001') return `links ${o.links}`;
    return o.buttons.join() === `copy-fix:tt:video:7000000000000000001,flag-card:tt~video~7000000000000000001:${POSTER}` ? null : `buttons ${o.buttons}`;
  });
  const slideshow = await run('TikTok slideshow -> 3 images, blurred (marked sensitive)', 'https://www.tiktok.com/@creator/photo/7000000000000000002', {}, ([o]) => {
    const gallery = walk(o.components).find((c) => c.type === TYPE.MediaGallery);
    return textOf(o.components).includes('TikTok  ·  Slideshow') && gallery.items.length === 3 && gallery.items.every((i) => i.spoiler) ? null : 'slideshow wrong';
  });
  await run('Instagram reel -> card with caption and video', 'https://www.instagram.com/reel/MOCKREEL/?igsh=abc', {}, ([o]) => {
    const text = textOf(cardsOf(o));
    if (!text.startsWith('### [📸 Instagram  ·  Reel](https://www.instagram.com/reel/MOCKREEL/)') || !text.includes('**reelmaker**\nReel caption & more')) return text;
    return mediaOf(o.components)[0] === 'https://instagramfix.com/videos/MOCKREEL/1' && o.links[0] === 'Open on Instagram -> https://www.instagram.com/reel/MOCKREEL/' ? null : 'reel media/link wrong';
  });
  await run('Instagram carousel -> 4 images', 'https://instagram.com/p/MOCKCAROUSEL/', {}, ([o]) =>
    textOf(o.components).includes('Instagram  ·  Carousel') && mediaOf(o.components).length === 4 ? null : 'carousel wrong');
  await run('Instagram profile link -> plain fixer link (no card)', 'https://www.instagram.com/someprofile/', {}, ([o]) => has(o.content, 'https://instagramfix.com/someprofile/'));
  await run('TikTok post the fixer does not know -> plain fixer link', 'https://www.tiktok.com/@x/video/1234', {}, ([o]) => has(o.content, 'https://tnktok.com/@x/video/1234'));
  await click('copy link on a TikTok card', 'copy-fix:tt:video:7000000000000000001', slideshow, {}, copyCheck(['https://tnktok.com/@i/video/7000000000000000001']));
  await click('copy link on an Instagram card', 'copy-fix:ig:reel:MOCKREEL', slideshow, {}, copyCheck(['https://instagramfix.com/reel/MOCKREEL/']));
  await click('flag a TikTok card, then Reveal rebuilds it privately', `flag-card:tt~photo~7000000000000000002:${POSTER}`, slideshow, { isMod: true }, (log) => {
    const u = log.find((l) => l[0] === 'update')?.[1];
    return u && !mediaOf(u.components).length && u.buttons.includes('reveal-card:tt~photo~7000000000000000002') ? null : 'not hidden';
  });
  await click('reveal a TikTok card', 'reveal-card:tt~photo~7000000000000000002', slideshow, {}, (log) =>
    mediaOf(log.find((l) => l[0] === 'editReply')?.[1].components ?? []).length === 3 ? null : 'no private card');
  await click('reveal an Instagram card', 'reveal-card:ig~reel~MOCKREEL', slideshow, {}, (log) =>
    mediaOf(log.find((l) => l[0] === 'editReply')?.[1].components ?? []).length === 1 ? null : 'no private card');

  // --- Twitch cards ---
  console.log('\n----- Twitch cards -----');
  const twitchLive = await run('Twitch channel that is live -> card with a stream snapshot, viewers, followers', 'watch https://www.twitch.tv/MockLive', {}, ([o]) => {
    const [card] = cardsOf(o);
    const text = textOf([card]);
    if (card?.accent_color !== 0x9146ff) return 'not a Twitch card';
    if (!text.startsWith('### [📺 Twitch  ·  🔴 Live](https://www.twitch.tv/mocklive)\n**MockLive**\nchill \\*stream\\*\n-# 🎮 Just Chatting')) return text;
    const wentLive = Date.parse('2026-09-27T10:00:00Z') / 1000;
    if (!text.includes('**1.2K** Viewers   **50K** Followers') || !text.includes(`-# Went live <t:${wentLive}:R>`)) return `stats: ${text}`;
    if (!mediaOf([card])[0]?.startsWith('https://static-cdn.jtvnw.net/previews-ttv/live_user_mocklive-1280x720.jpg?t=')) return `media ${mediaOf([card])}`;
    if (o.links.join() !== 'Open on Twitch -> https://www.twitch.tv/mocklive') return `links ${o.links}`;
    return o.buttons.join() === `copy-tw:channel:mocklive,flag-card:tw~channel~mocklive:${POSTER}` ? null : `buttons ${o.buttons}`;
  });
  await run('Twitch clip -> the clip plays in the card (720p, signed link), who clipped it', 'https://www.twitch.tv/mocklive/clip/MockClipSlug-abc?filter=clips', {}, ([o]) => {
    const text = textOf(cardsOf(o));
    if (!text.startsWith('### [📺 Twitch  ·  Clip](https://clips.twitch.tv/MockClipSlug-abc)\n**MockLive**\nPilot Kill\n-# 🎮 WARDOGS')) return text;
    if (!text.includes('**2K** Views') || !text.includes('  ·  0:21  ·  Clipped by Fan\\_1')) return `stats: ${text}`;
    if (mediaOf(o.components)[0] !== `https://clips.cdn.example/720/index.mp4?sig=sig123&token=${encodeURIComponent('{"expires":1}')}`) return `media ${mediaOf(o.components)}`;
    return o.links.join() === 'Open on Twitch -> https://clips.twitch.tv/MockClipSlug-abc' ? null : `links ${o.links}`;
  });
  const twitchVod = await run('Twitch past broadcast of a mature channel -> blurred thumbnail, length, start time kept', 'https://www.twitch.tv/videos/1234567890?t=1h2m3s', {}, ([o]) => {
    const text = textOf(cardsOf(o));
    const gallery = walk(o.components).find((c) => c.type === TYPE.MediaGallery);
    if (!text.startsWith('### [📺 Twitch  ·  Past Broadcast](https://www.twitch.tv/videos/1234567890?t=1h2m3s)')) return text;
    if (!gallery?.items[0].spoiler || !text.includes('⚠️ Marked sensitive by Twitch')) return 'not blurred';
    if (!text.includes('**212** Views') || !text.includes('  ·  2:43:14')) return `stats: ${text}`;
    return o.links.join() === 'Open on Twitch -> https://www.twitch.tv/videos/1234567890?t=1h2m3s' ? null : `links ${o.links}`;
  });
  await run('offline Twitch channel -> last stream; other Twitch pages stay in the text', 'see https://www.twitch.tv/directory and https://m.twitch.tv/mockoff/', {}, (out) => {
    if (out.length !== 2 || !out[0].content.includes('see https://www.twitch.tv/directory and')) return `first message: ${out[0]?.content}`;
    const text = textOf(cardsOf(out[1]));
    if (!text.startsWith('### [📺 Twitch  ·  Offline](https://www.twitch.tv/mockoff)\n**모크** @mockoff\nold stream\n-# 🎮 Halo Infinite')) return text;
    if (mediaOf(out[1].components).length) return 'an offline channel has nothing to show';
    return text.includes('**1** Follower\n-# Last live <t:') ? null : `stats: ${text}`;
  });
  await run('Twitch channel that does not exist -> plain link, Discord previews it', 'https://www.twitch.tv/nosuchchannel', {}, ([o]) => has(o.content, 'https://www.twitch.tv/nosuchchannel'));
  await run('Twitch clip with a very long name -> card still posts, only the button whose id would be too long (Flag) left off', `https://clips.twitch.tv/${LONG_CLIP_SLUG}`, {}, ([o]) =>
    o?.isCard && o.links.length === 1 && o.buttons.join() === `copy-tw:clip:${LONG_CLIP_SLUG}` ? null : `buttons ${o?.buttons}`);
  await click('copy link on a Twitch card', 'copy-tw:clip:MockClipSlug-abc', twitchLive, {}, copyCheck(['https://clips.twitch.tv/MockClipSlug-abc']));
  await click('reveal a Twitch card', 'reveal-card:tw~video~1234567890', twitchVod, {}, (log) =>
    mediaOf(log.find((l) => l[0] === 'editReply')?.[1].components ?? []).length === 1 ? null : 'no private card');

  // --- YouTube cards ---
  console.log('\n----- YouTube cards -----');
  const ytVideo = await run('YouTube video -> one card: no channel picture, Watch on YouTube / Watch on Discord buttons under the thumbnail, Video Summary button', 'https://youtu.be/dQw4w9WgXcQ?t=42&si=track', {}, (out) => {
    const [o] = out;
    if (out.length !== 1) return `${out.length} messages`;
    const [card] = cardsOf(o);
    const text = textOf([card]);
    if (card?.accent_color !== 0xff0000) return 'not a YouTube card';
    const title = '**[Never "Gonna" {Give} You \\*Up\\* \\[Official\\]](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42)**';
    if (!text.startsWith(`### [▶️ YouTube  ·  Video](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42)\n**Rick\\_Astley**\n${title}\n`)) return text;
    const uploaded = Date.parse('2009-10-24T23:57:33-07:00') / 1000;
    if (!text.includes('**1.8B** Views   **19.4M** Likes') || !text.includes(`-# <t:${uploaded}:R>  ·  3:33`)) return `stats: ${text}`;
    if (mediaOf([card]).join() !== 'https://i.ytimg.com/vi_webp/dQw4w9WgXcQ/maxresdefault.webp') return `media ${mediaOf([card])}`;
    if (thumbsOf([card]).length) return `the channel picture should be gone: ${thumbsOf([card])}`;
    const order = card.components.map((c) => c.type);
    if (order.indexOf(TYPE.ActionRow) !== order.indexOf(TYPE.MediaGallery) + 1) return `the watch buttons should sit right under the thumbnail: ${order}`;
    if (o.links.join() !== '▶️ Watch on YouTube -> https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42') return `link buttons ${o.links}`;
    const want = ['watch-yt:dQw4w9WgXcQ:42', 'watch-together:dQw4w9WgXcQ:42', 'copy-yt:video:dQw4w9WgXcQ', 'yt-summary:dQw4w9WgXcQ', `flag-card:yt~video~dQw4w9WgXcQ:${POSTER}`];
    return o.buttons.join() === want.join() ? null : `buttons ${o.buttons}`;
  });
  await run('YouTube Short without a summary -> "Short" card with its thumbnail, no Video Summary button', 'https://www.youtube.com/shorts/abcdefghijk', {}, ([o]) => {
    if (!textOf(cardsOf(o)).startsWith('### [▶️ YouTube  ·  Short](https://www.youtube.com/shorts/abcdefghijk)')) return textOf(cardsOf(o));
    if (o.buttons.some((b) => b.startsWith('yt-summary'))) return `buttons ${o.buttons}`;
    return mediaOf(o.components).join() === 'https://i.ytimg.com/vi_webp/abcdefghijk/maxresdefault.webp' ? null : `media ${mediaOf(o.components)}`;
  });
  await run('age-restricted YouTube video -> blurred thumbnail', 'https://www.youtube.com/watch?v=agerestrict', {}, ([o]) => {
    const gallery = walk(o.components).find((c) => c.type === TYPE.MediaGallery);
    return gallery?.items[0].spoiler && textOf(o.components).includes('⚠️ Marked sensitive by YouTube') ? null : 'not blurred';
  });
  await run('YouTube page unreadable -> card from YouTube\'s oEmbed basics', 'https://youtu.be/oembedOnly1', {}, ([o]) => {
    const text = textOf(cardsOf(o));
    if (!text.startsWith('### [▶️ YouTube  ·  Video](https://www.youtube.com/watch?v=oembedOnly1)\n**Some Channel**\n**[Just the basics](https://www.youtube.com/watch?v=oembedOnly1)**')) return text;
    return mediaOf(o.components).join() === 'https://i.ytimg.com/vi/oembedOnly1/hqdefault.jpg' && !text.includes('Views') ? null : `media ${mediaOf(o.components)}`;
  });
  await run('YouTube video that does not exist -> plain link, Discord previews it', 'https://youtu.be/nosuchvideo', {}, ([o]) => has(o.content, 'https://www.youtube.com/watch?v=nosuchvideo'));
  await click('copy link on a YouTube card', 'copy-yt:short:abcdefghijk', ytVideo, {}, copyCheck(['https://www.youtube.com/shorts/abcdefghijk']));
  await click('reveal a YouTube card', 'reveal-card:yt~video~dQw4w9WgXcQ', ytVideo, {}, (log) =>
    mediaOf(log.find((l) => l[0] === 'editReply')?.[1].components ?? []).length === 1 ? null : 'no private card');
  const invites = [];
  const hangout = {
    id: 'v1', permissionsFor: () => ({ has: () => true }),
    createInvite: async (options) => { invites.push(options); return { url: 'https://discord.gg/abc123' }; },
  };
  await click('Watch Together while in a voice channel -> private Watch Together invite for that channel + the link to paste', 'watch-together:dQw4w9WgXcQ:42', ytVideo, { voiceChannel: hangout }, (log) => {
    const r = log[0]?.[0] === 'reply' && log[0][1];
    if (!r || r.flags !== discord.MessageFlags.Ephemeral) return `reply ${JSON.stringify(r?.flags)}`;
    const [options] = invites;
    if (options?.targetType !== discord.InviteTargetType.EmbeddedApplication || options.targetApplication !== '880218394199220334') return `invite ${JSON.stringify(options)}`;
    return r.content.includes('<#v1>:** https://discord.gg/abc123') && r.content.includes('<https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42>') ? null : r.content;
  });
  await click('Watch Together while not in a voice channel -> asked to join one first, no invite', 'watch-together:dQw4w9WgXcQ:', ytVideo, {}, (log) =>
    (log[0]?.[1]?.content?.includes('Join a voice channel first') && invites.length === 1 ? null : `reply ${log[0]?.[1]?.content}`));
  await click('Watch Together in a voice channel the bot can\'t make invites in -> says so', 'watch-together:dQw4w9WgXcQ:', ytVideo,
    { voiceChannel: { ...hangout, permissionsFor: () => ({ has: () => false }) } }, (log) =>
    (log[0]?.[1]?.content?.includes("don't have permission to create invites") && invites.length === 1 ? null : `reply ${log[0]?.[1]?.content}`));
  await click('Watch Together in a DM -> explains it needs a server', 'watch-together:dQw4w9WgXcQ:', ytVideo, { inGuild: false }, (log) =>
    (log[0]?.[1]?.content?.includes('only works in a server') ? null : `reply ${log[0]?.[1]?.content}`));
  await click('Watch on Discord -> the video link privately, with its preview (so Discord\'s player shows), start time kept', 'watch-yt:dQw4w9WgXcQ:42', ytVideo, {}, (log) => {
    const r = log[0]?.[0] === 'reply' && log[0][1];
    const flags = new discord.MessageFlagsBitField(r?.flags);
    if (!r || !flags.has(discord.MessageFlags.Ephemeral) || flags.has(discord.MessageFlags.SuppressEmbeds)) return `reply ${JSON.stringify(r?.flags)}`;
    return r.content === 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42' ? null : `content ${r.content}`;
  });
  await click('Video Summary -> YouTube\'s AI summary, privately', 'yt-summary:dQw4w9WgXcQ', ytVideo, {}, (log) => {
    const r = log.find((l) => l[0] === 'editReply')?.[1];
    const text = textOf(r?.components ?? []);
    return log[0] === `deferReply(flags=${discord.MessageFlags.Ephemeral})` && text.startsWith('### ✨ Video Summary') &&
      text.includes('Rick promises {never} to give you up.\n\nOr let you down.') && text.includes("YouTube's AI") ? null : `summary: ${text}`;
  });
  await click('Video Summary on a video that no longer has one -> says so', 'yt-summary:abcdefghijk', ytVideo, {}, (log) =>
    log.find((l) => l[0] === 'editReply')?.[1].content.includes("doesn't have a summary") ? null : 'no message');
  await click('flag a YouTube card -> the card and its watch buttons are hidden', `flag-card:yt~video~dQw4w9WgXcQ:${POSTER}`, ytVideo, { isMod: true }, (log) => {
    const u = log.find((l) => l[0] === 'update')?.[1];
    return u && !mediaOf(u.components).length && !u.buttons.some((b) => b.startsWith('watch-yt')) && !u.links.length ? null : `still showing: ${u?.buttons} ${u?.links}`;
  });

  // --- /embeds settings ---
  console.log('\n----- /embeds settings -----');
  const command = async (label, subcommand, options, check, { canManage = true } = {}) => {
    crashed = [];
    const log = [];
    const i = {
      commandName: 'embeds', guildId: 'g1', channelId: 'c1', channel: { isThread: () => false },
      memberPermissions: { has: () => canManage }, user: { id: '333333333333333333', tag: 'admin#0001' }, guild: { name: 'Server One' },
      isChatInputCommand: () => true, isButton: () => false, deferred: false, replied: false,
      options: { getSubcommand: () => subcommand, getBoolean: (n) => options[n], getString: (n) => options[n] },
      reply: async (p) => { i.replied = true; log.push(p); },
    };
    await handlers.interactionCreate[0](i);
    const err = crashed.length ? crashed[0] : check(log[0]);
    if (err) failures++;
    console.log(`=== ${err ? 'FAIL' : 'ok  '} [/embeds ${subcommand}] ${label}${err ? `\n  CHECK FAILED: ${err}` : ''}`);
    if (log[0]) console.log(log[0].content.split('\n').map((l) => `      | ${l}`).join('\n'));
  };
  const privateReply = (sub) => (r) => (r?.flags === discord.MessageFlags.Ephemeral && r.content.includes(sub) ? null : `reply: ${r?.content}`);
  await command('someone without Manage Server (allowed in Integrations) -> refused, nothing changed', 'channel', { enabled: false },
    privateReply('Only people with the **Manage Server** permission'), { canManage: false });
  await command('shows the settings privately', 'status', {}, privateReply('**Link fixing in <#c1>:** on'));
  const botLog = [];
  const realLog = console.log;
  console.log = (...args) => { botLog.push(args.join(' ')); realLog(...args); };
  await command('turn link fixing off here', 'channel', { enabled: false }, privateReply('now **off** in <#c1>'));
  console.log = realLog;
  const logLine = botLog.find((l) => l.startsWith('/embeds:')) ?? '';
  console.log(`=== ${logLine === '/embeds: admin#0001 (333333333333333333) turned link fixing off in channel c1 in "Server One".' ? 'ok  ' : 'FAIL'} settings change logged with who made it`);
  if (!logLine.includes('admin#0001 (333333333333333333) turned link fixing off')) failures++;
  await run('channel turned off -> links left alone', 'https://x.com/jack/status/20', {}, (out) => (out.length ? 'should not post' : null));
  await run('...including in its threads', 'https://x.com/jack/status/20', { channelId: 't9', parentId: 'c1', channelType: discord.ChannelType.PublicThread }, (out) => (out.length ? 'should not post' : null));
  await command('turn it back on', 'channel', { enabled: true }, privateReply('now **on** in <#c1>'));
  await command('translate into Spanish', 'language', { language: 'es' }, privateReply('**Posts are translated into:** Spanish'));
  await run('English post, server language Spanish -> translated', 'https://x.com/u/status/9000000000000000012', {}, ([o]) =>
    textOf(o.components).includes('🌐 Translated from English\nHola') ? null : 'not translated to Spanish');
  await command('turn translation off', 'language', { language: 'off' }, privateReply('translation is off'));
  await run('translation off -> Japanese post shown as-is', 'https://x.com/u/status/9000000000000000008', {}, ([o]) =>
    textOf(o.components).includes('Translated') ? 'should not translate' : null);
  await command('back to English', 'language', { language: 'en' }, privateReply('English'));

  // --- posting as the sharer (webhooks) ---
  console.log('\n----- posting as the sharer -----');
  // The channel already has the test webhook (made by the bot, like in #bot-testing) - it must never be reused.
  fakeWebhooks.push({ id: '555', channelId: 'c1', name: 'Link Tester', token: 'tok', owner: { id: 'bot-user' }, send: async () => { throw new Error('posted through the TEST webhook'); } });
  await command('post as the person who shared', 'post-as', { who: 'sharer' }, privateReply('the person who shared them'));
  await run('card posted as "<server nickname> (Embed App)" with their avatar, their words without "shared:"', 'look at this https://x.com/jack/status/20', {}, ([o]) => {
    if (!o.viaWebhook || o.username !== 'Alex (server nickname) (Embed App)' || !o.avatarURL.includes('/guilds/g1/users/111/')) return `sent as ${o.username}`;
    return o.components[0].content === 'look at this' ? null : `header: ${o.components[0].content}`;
  });
  await run('plain links posted under the sharer too', 'https://www.wsj.com/mock-archived-article', {}, ([o]) =>
    o.viaWebhook && !o.content.includes('shared:') && o.content.startsWith('https://www.wsj.com/mock-archived-article') ? null : 'not via webhook');
  await run('in a thread -> the parent channel\'s webhook, posted into the thread', 'https://x.com/jack/status/20', { channelId: 't5', parentId: 'c1', channelType: discord.ChannelType.PublicThread }, ([o]) =>
    o.viaWebhook && o.threadId === 't5' ? null : `threadId ${o.threadId}`);
  await run('one webhook per channel, reused - its own, never the test webhook', 'https://x.com/jack/status/20', {}, ([o]) => {
    const own = fakeWebhooks.filter((w) => w.channelId === 'c1' && w.name === 'Cardify');
    return own.length === 1 && o.viaWebhook ? null : `${own.length} own webhooks, viaWebhook=${o?.viaWebhook}`;
  });
  // A webhook made by an older version, named after the bot: renamed to "Cardify" and reused, not duplicated.
  const olderHook = { id: '777', channelId: 'c8', name: 'Old Bot Name', token: 'tok', owner: { id: 'bot-user' } };
  olderHook.send = async (p) => { currentOut.push({ ...validate(p), viaWebhook: true, hook: olderHook.id }); return { url: 'https://discord.com/channels/g1/c8/webhook-post' }; };
  olderHook.edit = async ({ name }) => { olderHook.name = name; return olderHook; };
  fakeWebhooks.push(olderHook);
  await run('older webhook named after the bot -> renamed "Cardify" and reused, no second webhook', 'https://x.com/jack/status/20', { channelId: 'c8' }, ([o]) => {
    const inC8 = fakeWebhooks.filter((w) => w.channelId === 'c8');
    return o?.hook === '777' && olderHook.name === 'Cardify' && inC8.length === 1 ? null : `hook ${o?.hook}, name ${olderHook.name}, ${inC8.length} webhooks`;
  });
  fakeWebhooks.forEach((w) => { w.broken = true; });
  await run('webhook deleted -> falls back to posting as the bot', 'https://x.com/jack/status/20', {}, ([o]) =>
    !o.viaWebhook && textOf(o.components).startsWith('<@111111111111111111> shared:') ? null : 'did not fall back');
  await run('DM -> still a bot reply (no webhooks in DMs)', 'https://x.com/jack/status/20', { guild: false, canManage: false }, ([o]) => (o.isReply && !o.viaWebhook ? null : 'expected bot reply'));
  await command('back to posting as the bot', 'post-as', { who: 'bot' }, privateReply('the bot, with a "shared:" line'));

  // --- link archive ---
  console.log('\n----- link archive -----');
  const makeArchive = (id, guildId, guildName) => {
    const threads = []; // every thread this fake archive channel knows about
    const pins = []; // newest first, like Discord
    const anchors = []; // messages the bot sent into the channel
    const makeThread = (name, extra = {}) => {
      const t = { id: `${id}-t${threads.length}`, name, archived: false, deleted: false, posts: [], unarchived: 0, ...extra };
      t.send = async (p) => {
        if (t.deleted) throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
        t.posts.push(validate(p));
      };
      t.setArchived = async (v) => { t.archived = v; t.unarchived++; };
      threads.push(t);
      return t;
    };
    const channel = {
      id, guildId, name: 'links', type: discord.ChannelType.GuildText,
      guild: { name: guildName, members: { me: {} }, roles: { everyone } },
      permissionsFor: () => ({ missing: () => [], has: () => true }),
      threads: {
        fetchActive: async () => ({ threads: new discord.Collection(threads.filter((t) => !t.archived && !t.deleted).map((t, i) => [`a${i}`, t])) }),
        fetchArchived: async () => ({ threads: new discord.Collection(threads.filter((t) => t.archived && !t.deleted).map((t, i) => [`z${i}`, t])) }),
        create: async () => { throw new Error('should start threads from anchor messages now'); },
        fetch: async (tid) => threads.find((t) => t.id === tid && !t.deleted) ?? Promise.reject(Object.assign(new Error('Unknown Channel'), { code: 10003 })),
      },
      messages: { fetchPins: async () => ({ items: [...pins], hasMore: false }) },
      send: async (p) => {
        const m = {
          id: `${id}-m${anchors.length}`, author: { id: 'bot-user' }, content: p.content, flags: p.allowedMentions,
          pin: async () => { pins.unshift({ message: m, pinnedTimestamp: Date.now() }); },
          unpin: async () => { pins.splice(pins.findIndex((x) => x.message === m), 1); m.unpinned = true; },
          startThread: async ({ name, autoArchiveDuration }) => { await sleep(25); return makeThread(name, { id: m.id, autoArchiveDuration }); },
        };
        anchors.push(m);
        return m;
      },
    };
    return { channel, threads, makeThread, pins, anchors };
  };
  const server1 = makeArchive('999', 'g1', 'Server One');
  const server2 = makeArchive('888', 'g2', 'Server Two');
  const duplicate = makeArchive('777', 'g1', 'Server One');
  const { threads, makeThread } = server1;
  makeThread('Instagram Posts', { archived: true }); // pre-existing, auto-archived
  const archivesById = { 999: server1.channel, 888: server2.channel, 777: duplicate.channel };
  botClient.channels.fetch = async (id) => archivesById[id] ?? Promise.reject(new Error('Unknown Channel'));
  // Threads the 24-hour reply-thread cleanup will look at when the bot starts.
  const HOUR = 3600e3;
  const sweepThreads = [
    { id: 'old-reply', name: 'Top replies (3)', ownerId: 'bot-user', createdTimestamp: Date.now() - 25 * HOUR },
    { id: 'fresh-reply', name: 'Top replies (3)', ownerId: 'bot-user', createdTimestamp: Date.now() - 1 * HOUR },
    { id: 'archive-thread', name: 'X Posts', ownerId: 'bot-user', createdTimestamp: Date.now() - 30 * 24 * HOUR },
    { id: 'someone-elses', name: 'Top replies (3)', ownerId: 'someone', createdTimestamp: Date.now() - 48 * HOUR },
    { id: String(discord.SnowflakeUtil.generate({ timestamp: Date.parse('2021-06-01') })), name: 'Top comments (5)', ownerId: 'bot-user', createdTimestamp: null },
  ].map((t) => ({ ...t, edits: [], async edit(options) { this.edits.push(options); } }));
  const leftServers = [];
  for (const [id, name] of [['g1', 'Server One'], ['g2', 'Server Two'], ['g3', 'Server Three']]) {
    const threads = id === 'g1' ? sweepThreads : [];
    botClient.guilds.cache.set(id, {
      id, name, leave: async () => { leftServers.push(id); },
      channels: { fetchActiveThreads: async () => ({ threads: new discord.Collection(threads.map((t) => [t.id, t])) }) },
    });
  }
  let registeredCommands = null;
  botClient.application = { commands: { set: async (commands) => { registeredCommands = commands.map((c) => c.toJSON()); } } };
  await handlers.clientReady[0]({ user: { tag: 'bot#0001' } });
  const serverCheck = (label, problem) => {
    if (problem) failures++;
    console.log(`=== ${problem ? 'FAIL' : 'ok  '} ${label}${problem ? `\n  CHECK FAILED: ${problem}` : ''}`);
  };
  serverCheck('startup: leaves the server that isn\'t on ALLOWED_GUILD_IDS, and only that one', leftServers.join() === 'g3' ? null : `left ${leftServers}`);
  await handlers.guildCreate[0]({ id: 'g9', name: 'Stranger Server', leave: async () => { leftServers.push('g9'); } });
  await handlers.guildCreate[0]({ id: 'g2', name: 'Server Two', leave: async () => { leftServers.push('g2 (wrongly)'); } });
  serverCheck('added to an unlisted server -> leaves it; re-added to a listed one -> stays', leftServers.join() === 'g3,g9' ? null : `left ${leftServers}`);
  await run('link posted in an unlisted server (before it could leave) -> ignored', 'https://x.com/jack/status/20', { guildId: 'g9' },
    (out) => (out.length ? 'should be ignored' : null));

  const thread = (name) => threads.filter((t) => t.name === name && !t.deleted).at(-1);
  const postsIn = (name) => threads.filter((t) => t.name === name).flatMap((t) => t.posts.map((p) => p.content));
  const archiveCheck = async (label, fn) => {
    const err = await fn();
    if (err) failures++;
    console.log(`=== ${err ? 'FAIL' : 'ok  '} [archive] ${label}${err ? `\n  CHECK FAILED: ${err}` : ''}`);
  };

  await archiveCheck('reply threads close 24h after opening (archived + locked); fresh, archive, and others\' threads untouched', () => {
    const closed = sweepThreads.filter((t) => t.edits.length).map((t) => t.name + (t.createdTimestamp ? '' : ' (pre-2022)'));
    const edit = sweepThreads[0].edits[0];
    return closed.join(', ') === 'Top replies (3), Top comments (5) (pre-2022)' && edit.archived && edit.locked ? null : `closed: ${closed.join(', ')}`;
  });
  await archiveCheck('/embeds is registered at startup, admin-only, with its 4 subcommands', () => {
    const cmd = registeredCommands?.[0];
    const subs = cmd?.options?.map((o) => o.name).join(',');
    return cmd?.name === 'embeds' && subs === 'status,channel,language,post-as' && cmd.default_member_permissions === String(discord.PermissionFlagsBits.ManageGuild)
      ? null : JSON.stringify(cmd)?.slice(0, 200);
  });
  const pinOrder = (s) => s.pins.map((p) => p.message.content.match(/\*\*(.+?)\*\*/)[1]);
  await archiveCheck('startup: fresh server gets 5 pinned category messages, pins read X -> News', () => {
    const order = pinOrder(server2).join(' | ');
    if (order !== 'X Posts | TikTok Videos | Instagram Posts | YouTube Videos | News Articles') return `pins: ${order}`;
    if (server2.threads.length !== 5) return `${server2.threads.length} threads`;
    if (!server2.threads.every((t) => server2.anchors.some((m) => m.id === t.id))) return 'thread not attached to its pinned message';
    if (server2.threads.some((t) => t.autoArchiveDuration !== 10080)) return 'auto-archive should be a week';
    return null;
  });
  console.log(`   pinned message text: "${server2.anchors[0].content}"`);
  await archiveCheck('startup: existing Instagram thread reused (no duplicate anchor)', () =>
    pinOrder(server1).join(' | ') === 'X Posts | TikTok Videos | YouTube Videos | News Articles' && threads.filter((t) => t.name === 'Instagram Posts').length === 1 ? null : pinOrder(server1).join(' | '));
  await archiveCheck('startup: duplicate archive channel got no anchors', () => (duplicate.anchors.length === 0 ? null : 'anchors posted'));

  await Promise.all([run('two TikToks at once', 'https://www.tiktok.com/@a/video/1'), run('(second)', 'https://www.tiktok.com/@b/video/2')]);
  await archiveCheck('simultaneous links -> both land in the ONE TikTok thread', () =>
    threads.filter((t) => t.name === 'TikTok Videos').length === 1 && postsIn('TikTok Videos').length === 2 ? null : `threads=${threads.map((t) => t.name)}`);

  const before = threads.length - 3; // X/YouTube/News threads already exist since startup
  await run('mixed message -> fixed in channel', 'look https://vm.tiktok.com/ZMabc/ https://youtu.be/dQw4w9WgXcQ?si=track https://x.com/jack/status/20?s=20 https://www.nytimes.com/mock-paywall-article');
  await archiveCheck('mixed message fans out to 4 category threads, credited, linking to repost', () => {
    const want = { 'TikTok Videos': 'https://tnktok.com/ZMabc/', 'YouTube Videos': 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'X Posts': 'https://fxtwitter.com/jack/status/20', 'News Articles': 'https://www.nytimes.com/mock-paywall-article' };
    for (const [name, url] of Object.entries(want)) {
      const post = postsIn(name).at(-1) ?? '';
      if (!post.includes(url) || !post.includes('Shared by <@111111111111111111> in <#c1>') || !post.includes('/c1/repost')) return `${name}: ${JSON.stringify(post)}`;
    }
    if (threads.length - before !== 3) return `expected 3 new threads, got ${threads.length - before}`;
    if (thread('X Posts').autoArchiveDuration !== 10080) return 'thread should auto-archive after a week';
    return null;
  });
  for (const name of ['X Posts', 'YouTube Videos']) console.log(`   [${name}] ${postsIn(name).at(-1).replace(/\n/g, '\n   [' + name + '] ')}`);

  await run('youtube-only message -> a card per video; the channel link stays in the text', 'https://www.youtube.com/shorts/abcdefghijk https://m.youtube.com/watch?feature=share&v=dQw4w9WgXcQ&t=42s https://www.youtube.com/@somechannel', {},
    (out) => (out.length === 3 && out[0].content.includes('https://www.youtube.com/@somechannel') && out[1].isCard && out[2].isCard ? null : `${out.length} messages`));
  await archiveCheck('youtube: shorts + timestamp kept, tracking dropped, channel page skipped, links to the repost', () => {
    const post = postsIn('YouTube Videos').at(-1);
    return post.includes('https://www.youtube.com/shorts/abcdefghijk') && post.includes('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s') &&
      !post.includes('@somechannel') && !post.includes('feature=') && post.includes('/c1/repost') ? null : JSON.stringify(post);
  });

  await run('instagram link', 'https://www.instagram.com/p/Cabc/');
  await archiveCheck('reuses the existing (auto-archived) Instagram thread and reopens it', () => {
    const ig = threads.filter((t) => t.name === 'Instagram Posts');
    return ig.length === 1 && ig[0].unarchived === 1 && !ig[0].archived && ig[0].posts.length === 1 ? null : `ig threads=${ig.length}, unarchived=${ig[0]?.unarchived}`;
  });

  const oldTiktok = thread('TikTok Videos');
  oldTiktok.deleted = true;
  await Promise.all([run('tiktok after its thread was deleted', 'https://www.tiktok.com/@c/video/3'), run('(second, same moment)', 'https://www.tiktok.com/@c2/video/33')]);
  await archiveCheck('deleted thread: ONE replacement, both links in it, old anchor unpinned, new one pinned', () => {
    const live = threads.filter((t) => t.name === 'TikTok Videos' && !t.deleted);
    const oldAnchor = server1.anchors.find((m) => m.id === oldTiktok.id);
    if (live.length !== 1) return `${live.length} live TikTok threads`;
    if (live[0].posts.length !== 2) return `${live[0].posts.length} posts in new thread`;
    if (!oldAnchor?.unpinned) return 'stale anchor still pinned';
    if (pinOrder(server1).filter((n) => n === 'TikTok Videos').length !== 1) return `pins: ${pinOrder(server1)}`;
    return null;
  });

  const count = () => threads.reduce((n, t) => n + t.posts.length, 0);
  let n = count();
  await run('private channel', 'https://www.tiktok.com/@d/video/4', { public: false });
  await archiveCheck('private channel -> not copied to public archive', () => (count() === n ? null : 'leaked'));
  await run('private thread', 'https://www.tiktok.com/@d/video/4', { channelType: discord.ChannelType.PrivateThread });
  await archiveCheck('private thread -> not copied', () => (count() === n ? null : 'leaked'));
  await run('DM', 'https://www.tiktok.com/@d/video/4', { guild: false, canManage: false });
  await archiveCheck('DM -> not copied', () => (count() === n ? null : 'leaked'));
  await run('server 2 (has its own archive)', 'https://www.tiktok.com/@e/video/5', { guildId: 'g2' });
  await archiveCheck('server 2 link goes to server 2 archive only, in its own TikTok thread', () => {
    const tiktok2 = server2.threads.filter((t) => t.name === 'TikTok Videos');
    return count() === n && tiktok2.length === 1 && tiktok2[0].posts[0]?.content.includes('/@e/video/5') ? null : `server1 changed=${count() !== n}, s2 threads=${server2.threads.length}`;
  });
  const server2Posts = () => server2.threads.reduce((sum, t) => sum + t.posts.length, 0);
  await run('server 3 (no archive)', 'https://www.tiktok.com/@f/video/6', { guildId: 'g3' });
  await archiveCheck('server 3 -> not copied anywhere', () => (count() === n && server2Posts() === 1 ? null : 'leaked'));
  await archiveCheck('second archive channel for server 1 was ignored', () => (duplicate.threads.length === 0 ? null : 'duplicate channel used'));
  await run('inside an archive thread', 'https://www.tiktok.com/@d/video/4', { channelId: 't5', parentId: '999' });
  await archiveCheck('posted inside an archive thread -> not copied again', () => (count() === n ? null : 'duplicated'));
  await run('in the archive channel itself (your setup)', 'https://www.tiktok.com/@g/video/7', { channelId: '999' });
  await archiveCheck('posted in the archive channel itself -> archived (was the bug)', () =>
    postsIn('TikTok Videos').at(-1)?.includes('/@g/video/7') && postsIn('TikTok Videos').at(-1).includes('<#999>') ? null : 'not archived');
  n = count();
  await run('test webhook post', 'https://www.tiktok.com/@w/video/8', { bot: true, webhookId: '555' }, (out) => (out.length ? null : 'test post was ignored'));
  await archiveCheck('test webhook post is fixed but never archived', () => (count() === n ? null : 'archived a test post'));
  await run('some other bot/webhook', 'https://www.tiktok.com/@w/video/9', { bot: true, webhookId: '666' }, (out) => (out.length ? 'should ignore other bots' : null));
  await run('no supported links', 'hello https://example.com');
  await archiveCheck('unsupported link -> nothing archived', () => (count() === n ? null : 'archived something'));

  console.log(`\n${failures ? `${failures} FAILURE(S)` : 'ALL PASSED'}`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('HARNESS CRASHED:', err);
  process.exit(1);
});
