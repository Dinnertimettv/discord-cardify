const fs = require('fs');
const path = require('path');
const util = require('util');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { version: BOT_VERSION } = require('./package.json');
const { takeLock } = require('./instance');
const { getGuildSettings, updateGuildSettings } = require('./settings');
const { saveFlaggedCard, getFlaggedCard, forgetFlaggedCard } = require('./flagged');
const ytdlp = require('./ytdlp');
// Server features beyond fixing links, one file each in features/.
const roles = require('./features/roles');
const expressions = require('./features/expressions');
const alerts = require('./features/alerts');
const logs = require('./features/logs');
const moderation = require('./features/moderation');
const automod = require('./features/automod');
const welcome = require('./features/welcome');
const leveling = require('./features/leveling');
const music = require('./features/music');
const tempVoice = require('./features/tempvoice');
const help = require('./features/help');
const setup = require('./features/setup');
// /restart, for the bot's owner.
const restart = require('./features/restart');
// Who can use what, and where (/access, /setup).
const access = require('./features/access');
const FEATURES = [roles, expressions, alerts, logs, moderation, automod, welcome, leveling, music, tempVoice, help, setup, restart];
// Buttons and menus that belong to a feature follow its /access rules too.
const COMPONENT_FEATURES = { role: 'roles', 'role-menu': 'roles', music: 'music', vc: 'tempvoice' };
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  ComponentType,
  ContainerBuilder,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  IntentsBitField,
  InteractionContextType,
  InviteTargetType,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  Partials,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  SlashCommandBuilder,
  SnowflakeUtil,
  TextDisplayBuilder,
  ThreadAutoArchiveDuration,
  ThumbnailBuilder,
  escapeMarkdown,
} = require('discord.js');

// Only when started as the bot itself - not when the tests load this file.
const isMainProgram = require.main === module;
if (isMainProgram) startLogFile();

if (!process.env.DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is missing - add it to .env (see .env.example).');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Configuration (everything here can be overridden in .env)
// ---------------------------------------------------------------------------

// "Fixer" services. The bot builds its own cards from their data (X from
// fxtwitter's API; TikTok and Instagram from the fixers' Mastodon-style
// /api/v1/statuses feeds), and falls back to posting a plain fixer link -
// which Discord previews itself - when that data isn't available.
const FIX_DOMAIN = process.env.FIX_DOMAIN || 'fxtwitter.com';
// tnktok.com is fxTikTok itself - open source and actively maintained (other
// fixers like tiktokfix.com run copies of its code). It handles videos,
// slideshows, lives, and short links. a.tnktok.com adds the caption.
const TIKTOK_FIX_DOMAIN = process.env.TIKTOK_FIX_DOMAIN || 'tnktok.com';
// Maintained fork of InstaFix - ddinstagram.com was archived in April 2026.
const INSTAGRAM_FIX_DOMAIN = process.env.INSTAGRAM_FIX_DOMAIN || 'instagramfix.com';

// Paywalled news sites - links to these (or any of their subdomains) get a
// bypass. Only sites with a real paywall belong here: a free site would just
// get its links needlessly reposted with a bypass attempt.
const DEFAULT_PAYWALL_DOMAINS = [
  // US national news and magazines
  'nytimes.com', 'wsj.com', 'washingtonpost.com', 'latimes.com', 'bostonglobe.com',
  'cnn.com', 'reuters.com', 'thedailybeast.com', 'theatlantic.com',
  'newyorker.com', 'vanityfair.com', 'wired.com', 'nymag.com', 'theverge.com',
  'slate.com', 'newrepublic.com', 'nationalreview.com', 'harpers.org',
  'foreignpolicy.com', 'foreignaffairs.com', 'theathletic.com',
  // Business and finance
  'bloomberg.com', 'ft.com', 'economist.com', 'barrons.com', 'marketwatch.com',
  'businessinsider.com', 'forbes.com', 'fortune.com', 'hbr.org', 'theinformation.com',
  'seekingalpha.com',
  // Science and tech
  'technologyreview.com', 'scientificamerican.com', 'newscientist.com',
  'nationalgeographic.com',
  // US regional papers
  'chicagotribune.com', 'sfchronicle.com', 'seattletimes.com', 'startribune.com',
  'inquirer.com', 'miamiherald.com', 'dallasnews.com', 'houstonchronicle.com',
  'denverpost.com', 'ajc.com', 'baltimoresun.com', 'newsday.com', 'nydailynews.com',
  // UK and Ireland
  'telegraph.co.uk', 'thetimes.co.uk', 'thetimes.com', 'spectator.co.uk',
  'newstatesman.com', 'irishtimes.com',
  // Canada, Australia, and New Zealand
  'theglobeandmail.com', 'nationalpost.com', 'thestar.com', 'smh.com.au', 'theage.com.au',
  'theaustralian.com.au', 'afr.com', 'nzherald.co.nz',
  // Europe
  'lemonde.fr', 'lefigaro.fr', 'spiegel.de', 'zeit.de', 'faz.net', 'sueddeutsche.de',
  'handelsblatt.com', 'nzz.ch', 'elpais.com', 'corriere.it',
  // Asia and the Middle East
  'scmp.com', 'nikkei.com', 'japantimes.co.jp', 'haaretz.com',
];
// PAYWALL_DOMAINS in .env (comma-separated) replaces this list entirely.
const PAYWALL_DOMAINS = process.env.PAYWALL_DOMAINS
  ? process.env.PAYWALL_DOMAINS.split(',').map((domain) => domain.trim()).filter(Boolean)
  : DEFAULT_PAYWALL_DOMAINS;

// archive.ph is the only bypass the bot can actually verify (a real HTTP
// redirect to an existing snapshot). It's best-effort - it can be blocked by
// ISPs, slow, or captcha'd - so it always falls back to PAYWALL_FIX_URL.
const ARCHIVE_PH_ENABLED = (process.env.ARCHIVE_PH_ENABLED ?? 'true') !== 'false';
const ARCHIVE_PH_TIMEOUT_MS = Number(process.env.ARCHIVE_PH_TIMEOUT_MS) || 8000;
// removepaywall.com (like paywallskip.com) renders its result client-side, so
// the bot can't confirm it worked - which is why it's labeled "unverified".
const PAYWALL_FIX_URL =
  process.env.PAYWALL_FIX_URL || 'https://www.removepaywall.com/search?url=';

// Channels where every shared link is also copied into a thread for its
// category, credited to the poster. Comma-separated, one channel per server -
// links only ever go to the archive in the server they were posted in.
// Leave empty to turn link archiving off.
const LINK_ARCHIVE_CHANNEL_IDS = (process.env.LINK_ARCHIVE_CHANNEL_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
// The only servers the bot works in, comma-separated. If it's added to any
// other server (possible while "Public Bot" is on in the Developer Portal),
// it leaves right away. Leave empty to allow every server.
const ALLOWED_GUILD_IDS = new Set(
  (process.env.ALLOWED_GUILD_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
);

function isAllowedServer(guildId) {
  return ALLOWED_GUILD_IDS.size === 0 || ALLOWED_GUILD_IDS.has(guildId);
}

const ARCHIVE_THREAD_NAMES = {
  x: 'X Posts',
  tiktok: 'TikTok Videos',
  instagram: 'Instagram Posts',
  youtube: 'YouTube Videos',
  news: 'News Articles',
};

// Test posts from this webhook (see test/live.js) are handled like a person's
// message, so the bot can be tested end to end - but they're never archived.
const TEST_WEBHOOK_ID = process.env.TEST_WEBHOOK_URL?.match(/\/webhooks\/(\d+)\//)?.[1];

// Color for the classic embeds (replies posted in reply threads).
const EMBED_COLOR = 0x000000;
// Side-line colors for the post cards, one per platform.
const X_POST_COLOR = 0x0b5cad;
const TIKTOK_COLOR = 0xfe2c55;
const INSTAGRAM_COLOR = 0xe1306c;
const TWITCH_COLOR = 0x9146ff;
const YOUTUBE_COLOR = 0xff0000;
// X Community Notes get their own amber box under the post.
const COMMUNITY_NOTE_COLOR = 0xf2b705;
// The "hidden - flagged as NSFW" notice that replaces a flagged card.
const NOTICE_COLOR = 0x4e5058;
// The label older versions of the bot put on quoted posts - still recognized
// by the Copy link button on those older messages.
const QUOTE_LABEL = '↪ Quoted post';

// "Show top 3 replies" threads close (archive + lock) 24 hours after they're
// opened, so they don't pile up in the channel. They stay readable, but nobody
// can reopen them by posting. Checked every 30 minutes.
const REPLY_THREAD_LIFETIME_MS = 24 * 60 * 60 * 1000;
const REPLY_THREAD_CHECK_MS = 30 * 60 * 1000;
const REPLY_THREAD_NAME = /^(?:Top (?:replies|comments)|Thread) \(/;
// The most posts "Show thread" posts; longer threads end with a link to the rest.
const MAX_THREAD_POSTS = 20;

const BOT_USER_AGENT = `Spork/${BOT_VERSION} (Discord link-preview bot)`;
// News sites and archive.ph treat obvious bots differently, so use a browser UA there.
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 8000;
const MAX_LINKS_PER_PLATFORM = 5;

// Discord API limits - exceeding any of these makes the whole send fail.
const MAX_CONTENT_LENGTH = 2000;
const MAX_DESCRIPTION = 4096;
const MAX_FIELD_VALUE = 1024;
const MAX_BUTTONS_PER_ROW = 5;
const MAX_BUTTON_LABEL = 80;
const MAX_CUSTOM_ID = 100;
// A card message holds at most 4000 characters of text, so each post's text,
// translation, and Community Note are capped - more tightly when a quote puts
// two posts in one card - leaving room for the header and stats lines.
const MAX_CARD_TEXT = 4000;
const TEXT_LIMITS = {
  single: { text: 2200, translation: 800, note: 500 },
  pair: { text: 900, translation: 350, note: 350 },
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
    // Which voice channel someone is in, for the "Watch Together" button.
    GatewayIntentBits.GuildVoiceStates,
    // Reactions on role panels.
    GatewayIntentBits.GuildMessageReactions,
    // Bans and unbans, for the mod log.
    GatewayIntentBits.GuildModeration,
    // GuildMembers (joins and leaves) is added at login, only when it's turned
    // on in the Developer Portal - see enableMemberEvents.
  ],
  // Reaction and User let reactions on messages from before a restart through.
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function truncate(str, max) {
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

// Drops punctuation that ends the sentence rather than the URL ("...status/123.").
function trimUrl(url) {
  return url.replace(/[.,!?:;'")\]]+$/, '');
}

// Drops query strings and fragments - on social links these are share-tracking
// junk (igsh, is_from_webapp, ?s=20...), and stripping them also means the same
// post shared twice with different junk de-dupes as one link.
function cleanLink(url) {
  return trimUrl(url.split(/[?#]/)[0]);
}

// De-dupes by key (keeping first-seen order) and caps the result length.
function uniqueBy(items, keyOf, limit) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
}

function request(url, { timeoutMs = FETCH_TIMEOUT_MS, headers, ...options } = {}) {
  return fetch(url, {
    ...options,
    headers: { 'User-Agent': BOT_USER_AGENT, ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

// Frees the connection when only a response's status/final URL matters.
function discardBody(res) {
  res.body?.cancel().catch(() => {});
}

// ---------------------------------------------------------------------------
// Link patterns
// ---------------------------------------------------------------------------

// X/Twitter status links, including ones already on a fixer domain, so a
// pasted fxtwitter/vxtwitter/fixupx link still gets the full treatment.
// Captures: 1 = username, 2 = post id, 3 = trailing path/query.
const X_FIX_DOMAINS = [...new Set([FIX_DOMAIN, 'fxtwitter.com', 'vxtwitter.com', 'fixupx.com'])];
const TWEET_REGEX = new RegExp(
  `https?://(?:(?:www\\.|mobile\\.)?(?:twitter|x)\\.com|${X_FIX_DOMAINS.map(escapeRegex).join('|')})/(\\w+)/status(?:es)?/(\\d+)([^\\s<>]*)`,
  'gi'
);

// Any TikTok link (videos, slideshows, vm./vt. short links, m. mobile links).
const TIKTOK_REGEX = /https?:\/\/(?:www\.|vm\.|vt\.|m\.)?tiktok\.com\/[^\s<>]+/gi;

// Any Instagram link (posts, reels, carousels).
const INSTAGRAM_REGEX = /https?:\/\/(?:www\.|m\.)?instagram\.com\/[^\s<>]+/gi;

// YouTube video links only (watch, youtu.be, shorts, live) - channels,
// playlists and other pages are left alone.
const YOUTUBE_REGEX =
  /https?:\/\/(?:(?:www\.|m\.|music\.)?youtube\.com\/(?:watch\?(?:[^\s<>]*?&)?v=|shorts\/|live\/)|youtu\.be\/)[\w-]{11}(?![\w-])[^\s<>]*/gi;

// Matches any subdomain of a paywalled domain (but not e.g. nytimes.com.evil.com).
// Never matches anything if the list is emptied out.
const PAYWALL_REGEX = PAYWALL_DOMAINS.length
  ? new RegExp(
      `https?://(?:[\\w-]+\\.)*(?:${PAYWALL_DOMAINS.map(escapeRegex).join('|')})(?![\\w-]|\\.[\\w-])(?:/[^\\s<>]*)?`,
      'gi'
    )
  : /(?!)/g;

// Twitch channels, clips, and past broadcasts - only those, so other Twitch
// pages (the directory, settings, a channel's tabs...) are left alone.
// Captures: 1 = clip slug (clips.twitch.tv), 2 = past broadcast id,
// 3 = clip slug (twitch.tv/<channel>/clip/...), 4 = channel name.
const TWITCH_PAGES = [
  'bits', 'dashboard', 'directory', 'downloads', 'drops', 'embed', 'following', 'friends', 'inventory', 'jobs',
  'login', 'messages', 'moderator', 'p', 'popout', 'prime', 'search', 'settings', 'signup', 'store',
  'subscriptions', 'turbo', 'videos', 'wallet',
];
const TWITCH_REGEX = new RegExp(
  'https?://(?:clips\\.twitch\\.tv/(?:embed\\?clip=)?([\\w-]+)|(?:www\\.|m\\.)?twitch\\.tv/(?:videos/(\\d+)|\\w+/clip/([\\w-]+)|' +
    `(?!(?:${TWITCH_PAGES.join('|')})\\b)(\\w{3,25})(?!\\w|/[^\\s<>?#])))[^\\s<>]*`,
  'gi'
);

const ALL_LINK_REGEXES = [TWEET_REGEX, TIKTOK_REGEX, INSTAGRAM_REGEX, TWITCH_REGEX, YOUTUBE_REGEX, PAYWALL_REGEX];

// Links the bot itself produces - fixer, archive.ph, and paywall-bypass links -
// used to read the fixed links back out of its own messages (see fixedLinksIn).
// Includes fixers it used before, so Copy link still works on older messages.
const PREVIOUS_FIX_DOMAINS = ['tiktokfix.com'];
const FIXED_LINK_DOMAINS = [
  ...new Set([FIX_DOMAIN, TIKTOK_FIX_DOMAIN, INSTAGRAM_FIX_DOMAIN, ...PREVIOUS_FIX_DOMAINS, 'archive.ph']),
];
const FIXED_LINK_REGEX = new RegExp(
  `https?://(?:[\\w-]+\\.)?(?:${FIXED_LINK_DOMAINS.map(escapeRegex).join('|')})/[^\\s<>]*|${escapeRegex(PAYWALL_FIX_URL)}[^\\s<>]*`,
  'gi'
);

// The host part of each link that gets swapped for a fixer domain. Any
// subdomain is dropped - the fixers only serve their bare root.
const TIKTOK_HOST = /^https?:\/\/(?:www\.|vm\.|vt\.|m\.)?tiktok\.com/i;
const INSTAGRAM_HOST = /^https?:\/\/(?:www\.|m\.)?instagram\.com/i;

// Normalizes a YouTube video link (watch, youtu.be, shorts, live) to
// { kind: 'short' | 'video', id, time, url }, url being a clean canonical
// link - share-tracking params like ?si= dropped, any start time (?t=) kept.
// Returns null for non-video pages like channels and playlists.
function parseYouTubeLink(raw) {
  let url;
  try {
    url = new URL(trimUrl(raw));
  } catch {
    return null;
  }
  const [first, second] = url.pathname.split('/').filter(Boolean);
  let id = null;
  if (url.hostname === 'youtu.be') id = first;
  else if (first === 'watch') id = url.searchParams.get('v');
  else if (first === 'shorts' || first === 'live') id = second;
  if (!/^[\w-]{11}$/.test(id ?? '')) return null;

  if (first === 'shorts') return { kind: 'short', id, time: null, url: youtubeUrl('short', id) };
  // Start times look like 42, 42s, or 1h2m3s.
  const time = url.searchParams.get('t')?.match(/^\w+$/)?.[0] ?? null;
  return { kind: 'video', id, time, url: youtubeUrl('video', id, time) };
}

function youtubeUrl(kind, id, time) {
  if (kind === 'short') return `https://www.youtube.com/shorts/${id}`;
  return `https://www.youtube.com/watch?v=${id}${time ? `&t=${time}` : ''}`;
}

// A TWITCH_REGEX match -> { kind: 'channel' | 'clip' | 'video', id, url },
// url being the clean link (a past broadcast keeps its ?t= start time).
function parseTwitchMatch([raw, clipsSlug, videoId, clipSlug, channel]) {
  if (videoId) {
    const time = raw.match(/[?&]t=(\w+)/)?.[1];
    return { kind: 'video', id: videoId, url: `${twitchUrl('video', videoId)}${time ? `?t=${time}` : ''}` };
  }
  const slug = clipsSlug || clipSlug;
  if (slug) return { kind: 'clip', id: slug, url: twitchUrl('clip', slug) };
  const login = channel.toLowerCase();
  return { kind: 'channel', id: login, url: twitchUrl('channel', login) };
}

function twitchUrl(kind, id) {
  if (kind === 'clip') return `https://clips.twitch.tv/${id}`;
  if (kind === 'video') return `https://www.twitch.tv/videos/${id}`;
  return `https://www.twitch.tv/${id}`;
}

// ---------------------------------------------------------------------------
// X / Twitter (via fxtwitter's free, no-key public API)
// ---------------------------------------------------------------------------

async function fetchFxtwitter(path) {
  const res = await request(`https://api.fxtwitter.com/2/${path}`);
  // Outages can return an HTML error page, so don't assume the body is JSON.
  const data = await res.json().catch(() => null);
  if (data?.code !== 200) throw new Error(data?.message || `HTTP ${res.status}`);
  return data;
}

// v2 endpoint - the legacy one doesn't reliably include quoted posts. `lang`
// adds a `translation` field alongside the original text.
async function fetchTweet(id, { lang } = {}) {
  const { status } = await fetchFxtwitter(`status/${id}${lang ? `?lang=${lang}` : ''}`);
  if (!status) throw new Error('Unexpected fxtwitter response shape');
  return status;
}

// How many posts are in the author's own thread this post belongs to (1 when
// it isn't part of one), or 0 if fxtwitter couldn't say.
async function countThreadPosts(id) {
  const data = await fetchFxtwitter(`conversation/${id}`).catch(() => null);
  return data ? authorThread(data).length : 0;
}

// The author's own thread around a post, in order, from fxtwitter's
// conversation data: the posts above it are listed under `thread` (ending with
// the post itself), and the ones after it are among the replies - each one the
// author's reply to the one before.
function authorThread(data) {
  const author = (data.status ?? data.thread?.at(-1))?.author?.screen_name;
  const isAuthors = (post) => post && post.type !== 'tombstone' && post.author?.screen_name === author;
  // The author's run of posts just above this one - they may have replied into
  // someone else's conversation, so stop at the first post by anyone else.
  const chain = [];
  for (const post of [...(data.thread ?? [])].reverse()) {
    if (!isAuthors(post)) break;
    chain.unshift(post);
  }
  if (chain.length === 0 && isAuthors(data.status)) chain.push(data.status);
  const ownReplies = (data.replies ?? []).filter(isAuthors);
  for (let next; (next = ownReplies.find((reply) => reply.replying_to?.status === chain.at(-1)?.id)); ) chain.push(next);
  return chain;
}

// Replies ranked by likes, skipping deleted/hidden ones.
async function fetchTopReplies(id, count) {
  const data = await fetchFxtwitter(`conversation/${id}?ranking_mode=likes`);
  return (data.replies || []).filter((reply) => reply.type !== 'tombstone').slice(0, count);
}

// Whether a post in postLang should be translated into targetLang ('off' =
// never). `und` (undetermined - emoji-only or very short text) never is.
function needsTranslation(postLang, targetLang) {
  if (!postLang || targetLang === 'off' || postLang.toLowerCase() === 'und') return false;
  return postLang.toLowerCase().split('-')[0] !== targetLang.toLowerCase().split('-')[0];
}

const formatCount = (n) => (n ?? 0).toLocaleString();
// Short numbers like X shows them: 9,241 -> 9.2K.
const compactCount = (n) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n ?? 0);

// Classic embed for one post - used for the replies posted in reply threads.
// Every field is guarded, since nested post objects don't always carry the
// full field set - a missing field should degrade the embed, not throw.
function buildTweetEmbed(tweet) {
  const counts = `❤ ${formatCount(tweet.likes)}   🔁 ${formatCount(tweet.reposts)}   💬 ${formatCount(tweet.replies)}`;
  const handle = tweet.author?.screen_name ? ` (@${tweet.author.screen_name})` : '';

  const embed = new EmbedBuilder()
    .setAuthor({
      name: truncate(`${tweet.author?.name || 'Unknown'}${handle}`, 256),
      iconURL: tweet.author?.avatar_url,
      url: tweet.url,
    })
    .setColor(EMBED_COLOR)
    .setFooter({ text: counts });

  if (tweet.created_timestamp) embed.setTimestamp(tweet.created_timestamp * 1000);
  // Long-form posts can run to 25,000 characters.
  if (tweet.text) embed.setDescription(truncate(tweet.text, MAX_DESCRIPTION));

  // Translations are shown underneath the original rather than replacing it.
  if (tweet.translation?.text) {
    const sourceLang =
      tweet.translation.source_lang_en || tweet.translation.source_lang || 'another language';
    embed.addFields({
      name: `🌐 Translated from ${sourceLang}`,
      value: truncate(tweet.translation.text, MAX_FIELD_VALUE),
    });
  }

  // Multiple photos come back pre-stitched into one "mosaic" image.
  const imageUrl = tweet.media?.mosaic?.formats?.jpeg || tweet.media?.photos?.[0]?.url;
  if (imageUrl) embed.setImage(imageUrl);

  return embed;
}

// Turns one X link into message parts (see handleMessage): a card message of
// its own. Any failure falls back to the plain fixer link, which Discord can
// still preview on its own.
async function processTweetLink([, user, id, rest], settings) {
  const link = `https://${FIX_DOMAIN}/${user}/status/${id}${cleanLink(rest)}`;
  try {
    const [tweet, threadLength] = await Promise.all([loadTweet(id, settings.language), countThreadPosts(id)]);
    const quoted = tweet.quote?.type === 'tombstone' ? null : tweet.quote;
    // The translate button shows on posts that aren't in the server's language.
    const serverLanguage = settings.language === 'off' ? 'en' : settings.language;
    const card = {
      components: buildTweetComponents(tweet),
      open: { label: 'Open on 𝕏', url: tweet.url || `https://x.com/${user}/status/${id}` },
      extraLinks: quoted?.url ? [{ label: 'Open quoted post', url: quoted.url }] : [],
      copyId: `copy-x:${tweet.author?.screen_name || 'i'}:${id}`,
      revealKey: id,
      repliesId: tweet.replies > 0 ? id : null,
      threadId: threadLength > 1 ? id : null,
      threadLength,
      downloadId: postVideoUrls(tweet).length || postVideoUrls(quoted).length ? `dl:x:${id}` : null,
      translateId: tweet.text && needsTranslation(tweet.lang, serverLanguage) ? `translate-x:${id}` : null,
    };
    return [{ card }];
  } catch (err) {
    console.error(`Couldn't fetch tweet ${id}:`, err.message);
    return [{ text: link }];
  }
}

// Fetches a post, re-fetching once with a translation if the post or its
// quote isn't in the server's language (shown under the original, not instead).
async function loadTweet(id, language = 'en') {
  const tweet = await fetchTweet(id);
  const translate =
    needsTranslation(tweet.lang, language) ||
    (tweet.quote?.type !== 'tombstone' && needsTranslation(tweet.quote?.lang, language));
  if (!translate) return tweet;
  return fetchTweet(id, { lang: language }).catch((err) => {
    console.error(`Translation fetch failed for tweet ${id}, showing original only:`, err.message);
    return tweet;
  });
}

// An X post as the bot's own card. Videos play right in the card, so there's
// no link to show. A post that quotes another holds the quoted post inside the
// same card, under a "↪ Quoting" heading - so one card is always one shared
// link. Only one level deep - a quote of a quote isn't unwound further.
// Community Notes get their own amber box under the card.
function buildTweetComponents(tweet) {
  const { quote } = tweet;
  const limits = quote ? TEXT_LIMITS.pair : TEXT_LIMITS.single;
  const card = new ContainerBuilder().setAccentColor(X_POST_COLOR);

  const kind = tweet.replying_to?.screen_name ? `Replying to @${escapeMarkdown(tweet.replying_to.screen_name)}` : 'Post';
  addTextWithAvatar(
    card,
    [
      linkedHeading(`𝕏  ·  ${kind}`, tweet.url),
      postNameLine(tweet),
      tweet.text && truncate(tweet.text, limits.text),
    ]
      .filter(Boolean)
      .join('\n'),
    tweet.author?.avatar_url
  );
  addTranslation(card, tweet, limits);
  addMedia(card, postMediaUrls(tweet), { sensitive: tweet.possibly_sensitive, platform: 'X' });
  addPoll(card, tweet.poll);

  if (quote) {
    card.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    addQuotedPost(card, quote, limits);
  }

  addStatsFooter(
    card,
    [
      [tweet.replies, 'Reply', 'Replies'],
      [tweet.reposts, 'Repost', 'Reposts'],
      [tweet.likes, 'Like', 'Likes'],
      [tweet.views, 'View', 'Views'],
    ],
    { timestamp: tweet.created_timestamp, source: tweet.source }
  );

  const notes = [
    communityNote(tweet, limits, 'Readers added context'),
    quote?.type !== 'tombstone' && communityNote(quote, limits, 'Readers added context to the quoted post'),
  ].filter(Boolean);
  return [card, ...notes];
}

// The quoted post, inside the quoting post's card, laid out like the post
// itself: its author's profile picture on the right, its author, its text set
// off with Discord's quote line, then its photos and videos (videos play right
// in the card).
function addQuotedPost(card, quote, limits) {
  if (quote.type === 'tombstone') {
    card.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### ↪ Quoting\n*The quoted post is unavailable (${quote.reason || 'unknown reason'}).*`)
    );
    return;
  }

  // `>>>` quotes everything after it, so the text has to come last.
  const content = [linkedHeading('↪ Quoting', quote.url), postNameLine(quote), quote.text && `>>> ${truncate(quote.text, limits.text)}`]
    .filter(Boolean)
    .join('\n');
  addTextWithAvatar(card, content, quote.author?.avatar_url);
  addTranslation(card, quote, limits);
  addMedia(card, postMediaUrls(quote), { sensitive: quote.possibly_sensitive, platform: 'X' });
}

// A card's bold heading, linked to the post the card shows. Discord cards
// can't be clicked as a whole, so the heading does what a classic embed's
// title link did.
function linkedHeading(text, url) {
  return `### ${url ? `[${text}](${url.replace(/\)/g, '%29')})` : text}`;
}

// "**Name** @handle"
function postNameLine(post) {
  const handle = post.author?.screen_name ? ` @${escapeMarkdown(post.author.screen_name)}` : '';
  return `**${escapeMarkdown(post.author?.name || 'Unknown')}**${handle}`;
}

// Every photo and video in a post, in order.
function postMediaUrls(post) {
  return (post.media?.all ?? [...(post.media?.photos ?? []), ...(post.media?.videos ?? [])])
    .map((item) => item.url)
    .filter(Boolean);
}

// Just a post's video files (GIFs come as videos too) - for "Download video".
function postVideoUrls(post) {
  if (!post || post.type === 'tombstone') return [];
  const videos = post.media?.all
    ? post.media.all.filter((item) => item.type === 'video' || item.type === 'gif')
    : (post.media?.videos ?? []);
  return videos.map((item) => item.url).filter(Boolean);
}

// An X poll: the vote count and when it ends, then each choice with a bar
// and its share of the votes.
function addPoll(card, poll) {
  if (!poll?.choices?.length) return;
  const endsAt = unixTime(poll.ends_at);
  const ended = endsAt !== null && endsAt * 1000 <= Date.now();
  const votes = poll.total_votes ?? 0;
  const header = [
    '📊 **Poll**',
    `${votes.toLocaleString()} ${votes === 1 ? 'vote' : 'votes'}`,
    ended ? 'final results' : endsAt && `ends <t:${endsAt}:R>`,
  ]
    .filter(Boolean)
    .join('  ·  ');
  const choices = poll.choices.map((choice) => {
    const percent = Math.round(choice.percentage ?? 0);
    const filled = Math.round(percent / 10);
    return `\`${'█'.repeat(filled)}${'░'.repeat(10 - filled)}\` **${percent}%**  ${escapeMarkdown(choice.label ?? '')}`;
  });
  card.addTextDisplayComponents(new TextDisplayBuilder().setContent([header, ...choices].join('\n')));
}

// A translation, shown under the original rather than replacing it.
function addTranslation(card, post, limits) {
  if (!post.translation?.text) return;
  const sourceLang = post.translation.source_lang_en || post.translation.source_lang || 'another language';
  card.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`-# 🌐 Translated from ${sourceLang}\n${truncate(post.translation.text, limits.translation)}`)
  );
}

// A post's X Community Note as an amber box, or null if it has none.
function communityNote(post, limits, title) {
  if (!post?.community_note?.text) return null;
  return new ContainerBuilder()
    .setAccentColor(COMMUNITY_NOTE_COLOR)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**📝 ${title}**\n${truncate(post.community_note.text, limits.note)}\n-# Community Note from X`)
    );
}

// The card's opening text, with the author's avatar beside it when there is one.
function addTextWithAvatar(card, content, avatarUrl) {
  const text = new TextDisplayBuilder().setContent(content);
  if (!avatarUrl) {
    card.addTextDisplayComponents(text);
    return;
  }
  card.addSectionComponents(
    new SectionBuilder().addTextDisplayComponents(text).setThumbnailAccessory(new ThumbnailBuilder().setURL(avatarUrl))
  );
}

// Photos and videos in a gallery - videos play right in the card - blurred
// until clicked when the platform marked them sensitive.
function addMedia(card, urls, { sensitive = false, platform }) {
  if (urls.length === 0) return;
  card.addMediaGalleryComponents(
    new MediaGalleryBuilder().addItems(
      urls.slice(0, 10).map((url) => new MediaGalleryItemBuilder().setURL(url).setSpoiler(Boolean(sensitive)))
    )
  );
  if (sensitive) {
    card.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# ⚠️ Marked sensitive by ${platform} - click the media to show it`)
    );
  }
}

// A divider, then "**303** Replies   **1.9K** Reposts ..." (skipping counts the
// platform didn't give), then how long ago it was posted and from which app.
function addStatsFooter(card, stats, { timestamp, source }) {
  const bar = stats
    .filter(([count]) => count !== undefined && count !== null)
    .map(([count, one, many]) => `**${typeof count === 'number' ? compactCount(count) : count}** ${count === 1 ? one : many}`)
    .join('   ');
  const meta = [timestamp && `<t:${timestamp}:R>`, source].filter(Boolean).join('  ·  ');
  if (!bar && !meta) return;
  card.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  card.addTextDisplayComponents(new TextDisplayBuilder().setContent([bar, meta && `-# ${meta}`].filter(Boolean).join('\n')));
}

// ---------------------------------------------------------------------------
// TikTok and Instagram (via the fixers' Mastodon-style status feeds)
// ---------------------------------------------------------------------------

// Resolves a TikTok link to { kind: 'video' | 'photo', id }. Share links
// (vm.tiktok.com/..., tiktok.com/t/...) redirect to the full link, which is
// read from the redirect rather than followed.
async function resolveTikTokLink(url) {
  const direct = url.match(/\/(video|photo)\/(\d+)/);
  if (direct) return { kind: direct[1], id: direct[2] };
  const res = await request(url, { redirect: 'manual', headers: { 'User-Agent': BROWSER_USER_AGENT } });
  discardBody(res);
  const found = res.headers.get('location')?.match(/\/(video|photo)\/(\d+)/);
  if (!found) throw new Error(`share link didn't lead to a video (HTTP ${res.status})`);
  return { kind: found[1], id: found[2] };
}

// Instagram post/reel links -> { kind: 'p' | 'reel', code }; null for other
// pages (profiles etc.), which just get the fixer link.
function parseInstagramLink(url) {
  const match = url.match(/instagram\.com\/(?:[\w.]+\/)?(p|reels?|tv)\/([\w-]+)/i);
  if (!match) return null;
  return { kind: match[1].toLowerCase().startsWith('reel') ? 'reel' : 'p', code: match[2] };
}

function instagramPostUrl(kind, code) {
  return `https://www.instagram.com/${kind}/${code}/`;
}

// A TikTok or Instagram post's video files - for "Download video".
function fixerVideoUrls(status) {
  return (status.media_attachments ?? [])
    .filter((item) => item.type === 'video' || item.type === 'gifv')
    .map((item) => item.url)
    .filter(Boolean);
}

async function fetchFixerStatus(domain, id) {
  const res = await request(`https://${domain}/api/v1/statuses/${encodeURIComponent(id)}`);
  const status = await res.json().catch(() => null);
  if (!res.ok || !status?.id) throw new Error(`HTTP ${res.status}`);
  return status;
}

function htmlToText(html) {
  return decodeHtmlEntities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*<p>/gi, '\n\n').replace(/<[^>]+>/g, '')).trim();
}

// fxTikTok puts the stats at the end of the text as "❤️ 35.2K 💬 5.7K 🔁 1.5K".
const TIKTOK_STATS = /❤️\s*([\d.,]+[KMB]?)\s*💬\s*([\d.,]+[KMB]?)\s*🔁\s*([\d.,]+[KMB]?)/;

// A TikTok or Instagram post as a card, in the same style as X posts: a bold
// platform heading linked to the post, name, caption, media (videos play in
// the card), and stats.
function buildFixerCard(status, { platform, kind, url = status.url }) {
  const isTikTok = platform === 'tiktok';
  let caption = htmlToText(status.content ?? '');
  let stats = [];
  const tikTokStats = isTikTok && caption.match(TIKTOK_STATS);
  if (tikTokStats) {
    stats = [
      [tikTokStats[1], 'Like', 'Likes'],
      [tikTokStats[2], 'Comment', 'Comments'],
      [tikTokStats[3], 'Share', 'Shares'],
    ];
    caption = caption.replace(tikTokStats[0], '').trim();
  }

  const media = status.media_attachments ?? [];
  const label = isTikTok
    ? media.some((item) => item.type === 'video') ? 'Video' : 'Slideshow'
    : kind === 'reel' ? 'Reel' : media.length > 1 ? 'Carousel' : 'Post';
  const account = status.account ?? {};
  // Without the check-mark badge a fixer may add to verified accounts' names.
  const name = (account.display_name || '').replace(/\s*[☑✅✔]️?\s*$/u, '') || account.username || 'Unknown';
  const handle = account.username && account.username !== name ? ` @${escapeMarkdown(account.username)}` : '';

  const card = new ContainerBuilder().setAccentColor(isTikTok ? TIKTOK_COLOR : INSTAGRAM_COLOR);
  addTextWithAvatar(
    card,
    [
      linkedHeading(`${isTikTok ? '🎵 TikTok' : '📸 Instagram'}  ·  ${label}`, url),
      `**${escapeMarkdown(name)}**${handle}`,
      caption && truncate(caption, TEXT_LIMITS.single.text),
    ]
      .filter(Boolean)
      .join('\n'),
    account.avatar
  );
  addMedia(card, media.map((item) => item.url).filter(Boolean), {
    sensitive: status.sensitive,
    platform: isTikTok ? 'TikTok' : 'Instagram',
  });
  const posted = Date.parse(status.created_at);
  addStatsFooter(card, stats, { timestamp: Number.isNaN(posted) ? null : Math.floor(posted / 1000) });
  return card;
}

// TikTok and Instagram links become cards built from the fixers' data; if that
// data isn't available, the plain fixer link goes out instead.
async function processTikTokLink({ original, fixed }) {
  try {
    const { kind, id } = await resolveTikTokLink(original);
    const status = await fetchFixerStatus(TIKTOK_FIX_DOMAIN, id);
    const url = status.url || original;
    const card = {
      components: [buildFixerCard(status, { platform: 'tiktok', url })],
      open: { label: 'Open on TikTok', url },
      extraLinks: [],
      copyId: `copy-fix:tt:${kind}:${id}`,
      downloadId: fixerVideoUrls(status).length ? `dl:tt:${id}` : null,
      revealKey: `tt~${kind}~${id}`,
    };
    return [{ card }];
  } catch (err) {
    console.error(`Couldn't build a TikTok card for ${original}:`, err.message);
    return [{ text: fixed }];
  }
}

async function processInstagramLink({ original, fixed }) {
  const post = parseInstagramLink(original);
  if (!post) return [{ text: fixed }];
  try {
    const status = await fetchFixerStatus(INSTAGRAM_FIX_DOMAIN, post.code);
    const url = instagramPostUrl(post.kind, post.code);
    const card = {
      components: [buildFixerCard(status, { platform: 'instagram', kind: post.kind, url })],
      open: { label: 'Open on Instagram', url },
      extraLinks: [],
      copyId: `copy-fix:ig:${post.kind}:${post.code}`,
      downloadId: fixerVideoUrls(status).length ? `dl:ig:${post.code}` : null,
      revealKey: `ig~${post.kind}~${post.code}`,
    };
    return [{ card }];
  } catch (err) {
    console.error(`Couldn't build an Instagram card for ${original}:`, err.message);
    return [{ text: fixed }];
  }
}

// ---------------------------------------------------------------------------
// Twitch (via the API twitch.tv's own website uses)
// ---------------------------------------------------------------------------

// Twitch has no free public feed like fxtwitter's, so its cards come from the
// GraphQL API twitch.tv's own website uses, with the site's public client ID -
// the same way open-source tools like streamlink read it. It's unofficial: if
// Twitch changes it, the links go out as plain links, which Discord previews.
const TWITCH_GQL_URL = 'https://gql.twitch.tv/gql';
const TWITCH_WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const TWITCH_QUERIES = {
  channel: `query($id: String!) { user(login: $id) { login displayName profileImageURL(width: 150)
    broadcastSettings { isMature }
    stream { title viewersCount createdAt game { name } previewImageURL(width: 1280, height: 720) }
    lastBroadcast { title startedAt game { name } }
    followers { totalCount } } }`,
  video: `query($id: ID!) { video(id: $id) { title lengthSeconds viewCount createdAt
    previewThumbnailURL(width: 1280, height: 720) game { name }
    owner { login displayName profileImageURL(width: 150) broadcastSettings { isMature } } } }`,
  clip: `query($id: ID!) { clip(slug: $id) { title viewCount createdAt durationSeconds thumbnailURL
    curator { displayName } game { name }
    broadcaster { login displayName profileImageURL(width: 150) broadcastSettings { isMature } }
    videoQualities { quality sourceURL }
    playbackAccessToken(params: { platform: "web", playerType: "site", playerBackend: "mediaplayer" }) { signature value } } }`,
};

// A channel ("user" to Twitch), clip, or past broadcast; throws if it doesn't exist.
async function fetchTwitch(kind, id) {
  const res = await request(TWITCH_GQL_URL, {
    method: 'POST',
    headers: { 'Client-Id': TWITCH_WEB_CLIENT_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: TWITCH_QUERIES[kind], variables: { id } }),
  });
  const body = await res.json().catch(() => null);
  const item = body?.data?.[kind === 'channel' ? 'user' : kind];
  if (!res.ok || !item) throw new Error(body?.errors?.[0]?.message || (res.ok ? 'not found' : `HTTP ${res.status}`));
  return item;
}

// A Twitch channel, clip, or past broadcast as a card, in the same style as
// the others. Clips play in the card. Streams and past broadcasts can't
// (Twitch only serves those as live playlists, which Discord can't play), so
// they show a still: a snapshot of the stream at the moment it was shared, or
// the broadcast's thumbnail.
function buildTwitchCard(kind, item, url) {
  const owner = { channel: item, video: item.owner, clip: item.broadcaster }[kind] ?? {};
  const stream = kind === 'channel' ? item.stream : null;
  const past = kind === 'channel' ? item.lastBroadcast : null;
  let label, title, game, media, stats, footer;
  if (kind === 'clip') {
    [label, title, game] = ['Clip', item.title, item.game?.name];
    media = twitchClipVideo(item) || item.thumbnailURL;
    stats = [[item.viewCount, 'View', 'Views']];
    footer = {
      timestamp: unixTime(item.createdAt),
      source: [
        item.durationSeconds && formatDuration(item.durationSeconds),
        item.curator?.displayName && `Clipped by ${escapeMarkdown(item.curator.displayName)}`,
      ]
        .filter(Boolean)
        .join('  ·  '),
    };
  } else if (kind === 'video') {
    [label, title, game] = ['Past Broadcast', item.title, item.game?.name];
    // Broadcasts still being processed get a placeholder "404" image.
    media = item.previewThumbnailURL?.includes('/_404/') ? null : item.previewThumbnailURL;
    stats = [[item.viewCount, 'View', 'Views']];
    footer = { timestamp: unixTime(item.createdAt), source: item.lengthSeconds && formatDuration(item.lengthSeconds) };
  } else if (stream) {
    [label, title, game] = ['🔴 Live', stream.title, stream.game?.name];
    // The query makes Discord fetch a fresh snapshot instead of an older cached one.
    media = stream.previewImageURL && `${stream.previewImageURL}?t=${Date.now()}`;
    stats = [
      [stream.viewersCount, 'Viewer', 'Viewers'],
      [item.followers?.totalCount, 'Follower', 'Followers'],
    ];
    footer = { source: unixTime(stream.createdAt) && `Went live <t:${unixTime(stream.createdAt)}:R>` };
  } else {
    [label, title, game] = ['Offline', past?.title, past?.game?.name];
    stats = [[item.followers?.totalCount, 'Follower', 'Followers']];
    footer = { source: unixTime(past?.startedAt) && `Last live <t:${unixTime(past.startedAt)}:R>` };
  }

  const name = owner.displayName || owner.login || 'Unknown';
  const handle = owner.login && owner.login !== name.toLowerCase() ? ` @${escapeMarkdown(owner.login)}` : '';
  const card = new ContainerBuilder().setAccentColor(TWITCH_COLOR);
  addTextWithAvatar(
    card,
    [
      linkedHeading(`📺 Twitch  ·  ${label}`, url),
      `**${escapeMarkdown(name)}**${handle}`,
      title && escapeMarkdown(truncate(title, 500)),
      game && `-# 🎮 ${escapeMarkdown(game)}`,
    ]
      .filter(Boolean)
      .join('\n'),
    owner.profileImageURL
  );
  addMedia(card, media ? [media] : [], { sensitive: owner.broadcastSettings?.isMature, platform: 'Twitch' });
  addStatsFooter(card, stats, footer);
  return card;
}

// A clip's video file, so it plays in the card. Twitch only serves it with a
// signed link that expires after about a day, so on an old card the clip may
// stop loading - the heading and "Open on Twitch" still lead to it, and Reveal
// fetches a fresh link. 720p at most, to keep the file small.
function twitchClipVideo(clip) {
  const token = clip.playbackAccessToken;
  const qualities = clip.videoQualities ?? [];
  const pick = qualities.find((q) => Number(q.quality) <= 720) ?? qualities.at(-1);
  if (!pick?.sourceURL || !token?.signature || !token.value) return null;
  return `${pick.sourceURL}?sig=${token.signature}&token=${encodeURIComponent(token.value)}`;
}

function unixTime(iso) {
  const ms = Date.parse(iso ?? '');
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

// 21 -> "0:21", 9794 -> "2:43:14"
function formatDuration(seconds) {
  const total = Math.round(seconds);
  const [h, m, s] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// A Twitch link becomes a card; if Twitch's data isn't available, the plain
// link goes out instead and Discord previews it.
async function processTwitchLink(link) {
  try {
    const card = {
      components: [buildTwitchCard(link.kind, await fetchTwitch(link.kind, link.id), link.url)],
      open: { label: 'Open on Twitch', url: link.url },
      extraLinks: [],
      copyId: `copy-tw:${link.kind}:${link.id}`,
      // Only clips have a video file - streams and past broadcasts don't.
      downloadId: link.kind === 'clip' ? `dl:tw:${link.id}` : null,
      revealKey: `tw~${link.kind}~${link.id}`,
    };
    return [{ card }];
  } catch (err) {
    console.error(`Couldn't build a Twitch card for ${link.url}:`, err.message);
    return [{ text: link.url }];
  }
}

// ---------------------------------------------------------------------------
// YouTube (via the video's public watch page)
// ---------------------------------------------------------------------------

// YouTube's official oEmbed feed only has the title, channel, and thumbnail,
// so the card is read from the video's public watch page, which has the rest
// (views, likes, upload date, length, and YouTube's AI video summary when the
// video has one) - no API key needed. If the page can't be read, the oEmbed
// basics still make a card.
async function fetchYouTube(id) {
  const page = await request(`https://www.youtube.com/watch?v=${id}`, {
    headers: { 'User-Agent': BROWSER_USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' },
  })
    .then((res) => (res.ok ? res.text() : ''))
    .catch(() => '');
  const player = jsonAfter(page, 'var ytInitialPlayerResponse = ');
  const details = player?.videoDetails;
  const ageRestricted =
    player?.microformat?.playerMicroformatRenderer?.isFamilySafe === false || /\bage\b/i.test(player?.playabilityStatus?.reason ?? '');
  if (details?.title) {
    const micro = player.microformat?.playerMicroformatRenderer ?? {};
    const likes = page.match(/along with ([\d,]+) other/)?.[1] ?? page.match(/"likeCount":"?(\d+)/)?.[1];
    const summary = jsonAfter(page, '"videoSummaryContentViewModel":')
      ?.paragraphs?.map((p) => p.videoSummaryParagraphViewModel?.text?.content)
      .filter(Boolean)
      .join('\n\n');
    return {
      title: details.title,
      channel: details.author,
      thumbnail: details.thumbnail?.thumbnails?.at(-1)?.url,
      views: Number(details.viewCount) || null,
      likes: likes ? Number(likes.replace(/,/g, '')) : null,
      seconds: Number(details.lengthSeconds) || null,
      published: unixTime(micro.publishDate),
      live: details.isLive ? 'live' : details.isUpcoming ? 'upcoming' : null,
      liveStart: unixTime(micro.liveBroadcastDetails?.startTimestamp),
      ageRestricted,
      summary: summary || null,
    };
  }
  const watchUrl = youtubeUrl('video', id);
  const res = await request(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watchUrl)}`);
  const basics = await res.json().catch(() => null);
  if (!res.ok || !basics?.title) throw new Error(`HTTP ${res.status}`);
  return { title: basics.title, channel: basics.author_name, thumbnail: basics.thumbnail_url, ageRestricted };
}

// The JSON object right after `marker` in a page's script, or null.
function jsonAfter(html, marker) {
  const start = html.indexOf('{', html.indexOf(marker) + marker.length);
  if (html.indexOf(marker) < 0 || start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (inString) {
      if (char === '\\') i++;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth++;
    } else if (char === '}' && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

// A YouTube video as a card, in the same style as the others but without the
// channel picture. YouTube videos can't play in a card (YouTube doesn't hand
// out a video file), so it shows the thumbnail with two buttons right under
// it: "Watch on YouTube", and "Watch on Discord", which privately shows the
// clicker Discord's own YouTube player (see watchOnDiscord). A card's picture
// can't be a link - Discord opens its picture viewer when it's clicked.
function buildYouTubeCard(video, { kind, id, time, url }) {
  const label = { live: '🔴 Live', upcoming: 'Upcoming' }[video.live] ?? (kind === 'short' ? 'Short' : 'Video');
  const card = new ContainerBuilder().setAccentColor(YOUTUBE_COLOR);
  addTextWithAvatar(
    card,
    [
      linkedHeading(`▶️ YouTube  ·  ${label}`, url),
      video.channel && `**${escapeMarkdown(video.channel)}**`,
      // The title links to the video, like in Discord's own YouTube preview.
      `**[${escapeMarkdown(truncate(video.title, 500)).replace(/[[\]]/g, '\\$&')}](${url})**`,
    ]
      .filter(Boolean)
      .join('\n'),
    null
  );
  addMedia(card, video.thumbnail ? [video.thumbnail] : [], { sensitive: video.ageRestricted, platform: 'YouTube' });
  card.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('▶️ Watch on YouTube').setURL(url),
      makeButton(`watch-yt:${id}:${time ?? ''}`, '▶️ Watch on Discord').setStyle(ButtonStyle.Primary),
      makeButton(`watch-together:${id}:${time ?? ''}`, '📺 Watch Together')
    )
  );
  let source = video.seconds && formatDuration(video.seconds);
  if (video.live === 'live' && video.liveStart) source = `Went live <t:${video.liveStart}:R>`;
  if (video.live === 'upcoming' && video.liveStart) source = `Starts <t:${video.liveStart}:R>`;
  addStatsFooter(
    card,
    [
      [video.views, 'View', 'Views'],
      [video.likes, 'Like', 'Likes'],
    ],
    { timestamp: video.live ? null : video.published, source }
  );
  return card;
}

// A YouTube link becomes a card - its watch buttons are inside it, so there's
// no "Open on YouTube" button under it, but there's a "Video Summary" button
// when YouTube has an AI summary of the video. If YouTube's data isn't
// available, the plain link goes out instead and Discord previews it.
async function processYouTubeLink(link) {
  try {
    const video = await fetchYouTube(link.id);
    const card = {
      components: [buildYouTubeCard(video, link)],
      open: null,
      extraLinks: [],
      copyId: `copy-yt:${link.kind}:${link.id}`,
      summaryId: video.summary ? link.id : null,
      revealKey: `yt~${link.kind}~${link.id}`,
    };
    return [{ card }];
  } catch (err) {
    console.error(`Couldn't build a YouTube card for ${link.url}:`, err.message);
    return [{ text: link.url }];
  }
}

// Rebuilds a card from its key (see card.revealKey) - for the Reveal button.
async function loadCardComponents(key, guildId) {
  const [platform, kind, id] = key.split('~');
  if (platform === 'tt') return [buildFixerCard(await fetchFixerStatus(TIKTOK_FIX_DOMAIN, id), { platform: 'tiktok' })];
  if (platform === 'tw') return [buildTwitchCard(kind, await fetchTwitch(kind, id), twitchUrl(kind, id))];
  if (platform === 'yt') return [buildYouTubeCard(await fetchYouTube(id), { kind, id, time: null, url: youtubeUrl(kind, id) })];
  if (platform === 'ig') {
    return [
      buildFixerCard(await fetchFixerStatus(INSTAGRAM_FIX_DOMAIN, id), { platform: 'instagram', kind, url: instagramPostUrl(kind, id) }),
    ];
  }
  return buildTweetComponents(await loadTweet(key, getGuildSettings(guildId).language));
}

// Total characters of text in a card's components - Discord caps a message at 4000.
function cardTextLength(components) {
  const measure = (component) =>
    (component.type === ComponentType.TextDisplay ? component.content.length : 0) +
    (component.components ?? []).reduce((sum, child) => sum + measure(child), 0);
  return components.reduce((sum, component) => sum + measure(component.toJSON?.() ?? component), 0);
}

// ---------------------------------------------------------------------------
// Paywalled news
// ---------------------------------------------------------------------------

const NAMED_ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };

// Single pass, so "&amp;#39;" correctly becomes "&#39;" rather than "'".
function decodeHtmlEntities(str) {
  return str.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
    if (code[0] !== '#') return NAMED_ENTITIES[code.toLowerCase()] ?? entity;
    const codePoint = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
  });
}

function extractTitle(html) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/\b(?:property|name)\s*=\s*["']og:title["']/i.test(tag)) continue;
    const content = tag.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const value = content?.[1] ?? content?.[2];
    if (value?.trim()) return value;
  }
  return html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
}

// Paywalled sites almost always still serve og:title/<title> for social
// previews even though the body is blocked. Best-effort: null on any failure.
async function fetchArticleTitle(url) {
  try {
    const res = await request(url, {
      headers: { 'User-Agent': BROWSER_USER_AGENT },
      timeoutMs: 6000,
    });
    // A blocked request (e.g. NYT's 403 bot check) serves a page titled just
    // "nytimes.com" - that's not the headline, so skip the title line instead.
    if (!res.ok) {
      discardBody(res);
      return null;
    }
    const raw = extractTitle(await res.text());
    if (!raw) return null;
    const title = decodeHtmlEntities(raw).replace(/\s+/g, ' ').trim();
    const siteName = new URL(url).hostname.replace(/^www\./, '');
    return title && title.toLowerCase() !== siteName ? truncate(title, 200) : null;
  } catch (err) {
    console.error(`Couldn't fetch title for ${url}:`, err.message);
    return null;
  }
}

// Looks for an *existing* archive.ph snapshot and returns its link, or null.
// Never triggers a new capture - that's slow and can require a captcha.
async function resolveArchivePh(url) {
  try {
    // Read where the lookup redirects instead of following it: the snapshot
    // page itself answers bots with a captcha (HTTP 429), but the redirect
    // alone proves a snapshot exists and says where it is. A never-archived
    // page answers 404.
    const res = await request(`https://archive.ph/newest/${url}`, {
      headers: { 'User-Agent': BROWSER_USER_AGENT },
      timeoutMs: ARCHIVE_PH_TIMEOUT_MS,
      redirect: 'manual',
    });
    discardBody(res);
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !location) return null;
    const snapshot = new URL(location, 'https://archive.ph');
    const found =
      snapshot.hostname === 'archive.ph' && snapshot.pathname !== '/' && !snapshot.pathname.startsWith('/newest/');
    return found ? snapshot.href : null;
  } catch (err) {
    console.error(`archive.ph lookup failed for ${url}:`, err.message);
    return null;
  }
}

async function processPaywallLink(url) {
  const archivedUrl = ARCHIVE_PH_ENABLED ? await resolveArchivePh(url) : null;
  if (archivedUrl) {
    // The original link still gets Discord's headline preview; the archived
    // copy (in <> so it doesn't add a second preview) is the readable version.
    return [{ text: `${url}\nArchived copy: <${archivedUrl}>` }];
  }

  // No verified snapshot: show the title, the original link (Discord still
  // previews it), and a clearly labeled bypass attempt, and let the reader judge.
  const title = await fetchArticleTitle(url);
  const lines = [
    title && `**${escapeMarkdown(title)}**`,
    url,
    `Bypass attempt (unverified): <${PAYWALL_FIX_URL}${encodeURIComponent(url)}>`,
  ];
  return [{ text: lines.filter(Boolean).join('\n') }];
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------
//
// Each message goes through three steps: find its links, post the fixed
// version (fixLinks), then copy the links into the archive (archiveLinks).
//
// In fixLinks, each link is turned into a list of "parts", assembled in order:
//   { card }  a post card (X, TikTok, Instagram, Twitch, YouTube) - a message of its own
//   { text }  a line of message content (news links, and fixer links for
//             posts whose card couldn't be built)

client.on(Events.MessageCreate, async (message) => {
  const isTestPost = Boolean(TEST_WEBHOOK_ID) && message.webhookId === TEST_WEBHOOK_ID;
  if (message.author.bot && !isTestPost) return;
  if (message.guildId && !isAllowedServer(message.guildId)) return;
  // Quiet channels (/access quiet-channel): no help, no XP, no link cards.
  if (message.inGuild() && access.isIgnoredChannel(message.guildId, message.channel, message.channelId)) return;
  if (help.isTextHelp(message.content)) {
    await help.handleText(message).catch((err) => console.error('!help failed:', err));
    return;
  }
  // XP counts even in channels with link fixing off (leveling has its own /access rules).
  leveling.onMessage(message).catch((err) => console.error('Leveling failed:', err));
  if (message.inGuild() && (isLinkFixingOff(message) || !access.allowsMessage(message, 'links'))) return;
  try {
    await handleMessage(message);
  } catch (err) {
    console.error(`Failed to process links in message ${message.id}:`, err);
  }
});

// Turned off with /embeds channel - threads follow their channel.
function isLinkFixingOff(message) {
  const { disabledChannels } = getGuildSettings(message.guildId);
  return disabledChannels.includes(message.channelId) || disabledChannels.includes(message.channel.parentId);
}

async function handleMessage(message) {
  const links = findLinks(message.content);
  // If fixing fails, the original message is still there to link back to.
  const repost = await fixLinks(message, links).catch((err) => {
    console.error(`Failed to fix links in message ${message.id}:`, err);
    return null;
  });
  await archiveLinks(message, links, repost ?? message);
}

// Pulls every supported link out of a message, de-duped and capped per
// platform. TikTok/Instagram links come back as { original, fixed }, `fixed`
// being the same link on the fixer's domain.
function findLinks(content) {
  const allMatches = (regex) => [...content.matchAll(regex)];
  const lowercase = (url) => url.toLowerCase();
  const fixerLinks = (regex, host, fixDomain) =>
    uniqueBy(allMatches(regex).map((m) => cleanLink(m[0])), lowercase, MAX_LINKS_PER_PLATFORM).map(
      (original) => ({ original, fixed: original.replace(host, `https://${fixDomain}`) })
    );

  return {
    tweets: uniqueBy(allMatches(TWEET_REGEX), (m) => m[2], MAX_LINKS_PER_PLATFORM),
    tiktok: fixerLinks(TIKTOK_REGEX, TIKTOK_HOST, TIKTOK_FIX_DOMAIN),
    instagram: fixerLinks(INSTAGRAM_REGEX, INSTAGRAM_HOST, INSTAGRAM_FIX_DOMAIN),
    twitch: uniqueBy(
      allMatches(TWITCH_REGEX).map(parseTwitchMatch),
      (link) => `${link.kind}:${link.id.toLowerCase()}`,
      MAX_LINKS_PER_PLATFORM
    ),
    news: uniqueBy(allMatches(PAYWALL_REGEX).map((m) => trimUrl(m[0])), lowercase, MAX_LINKS_PER_PLATFORM),
    youtube: uniqueBy(
      allMatches(YOUTUBE_REGEX).map((m) => parseYouTubeLink(m[0])).filter(Boolean),
      (video) => video.id,
      MAX_LINKS_PER_PLATFORM
    ),
  };
}

// Posts the fixed version of the message's links. Returns the first reposted
// message if the original was deleted, or null if the original is still there.
async function fixLinks(message, links) {
  const settings = getGuildSettings(message.guildId);

  // Every link is fetched in parallel; Promise.all keeps the results in order.
  const partGroups = await Promise.all([
    ...links.tiktok.map(processTikTokLink),
    ...links.instagram.map(processInstagramLink),
    ...links.twitch.map(processTwitchLink),
    ...links.youtube.map(processYouTubeLink),
    ...links.news.map(processPaywallLink),
    ...links.tweets.map((match) => processTweetLink(match, settings)),
  ]);

  // Links that rely on Discord's own previews go out together as plain text.
  // Each post card is a message of its own - card messages can't carry plain
  // text, and Discord wouldn't preview links in a message with cards anyway.
  const lines = [];
  const cards = [];
  for (const part of partGroups.flat()) {
    if (part.card) cards.push(part.card);
    else if (part.text) lines.push(part.text);
  }
  if (lines.length === 0 && cards.length === 0) return null;

  const canManage =
    message.inGuild() &&
    message.channel.permissionsFor(message.guild.members.me)?.has(PermissionFlagsBits.ManageMessages);
  // Attachments and stickers can't be reposted, so never delete a message that has them.
  const repostsOriginal = canManage && message.attachments.size === 0 && message.stickers.size === 0;

  if (!repostsOriginal) {
    // Can't (or shouldn't) delete: reply alongside the original instead. Hiding
    // someone else's broken preview also needs Manage Messages.
    if (canManage) await message.suppressEmbeds(true).catch(() => {});
    const [first, ...rest] = buildPayloads(message, lines, cards, { header: [] });
    await message.reply(first);
    for (const payload of rest) await message.channel.send(payload);
    return null;
  }

  // Repost under the sharer's own name and avatar when the server wants that
  // (the default) and a webhook is available; otherwise as the bot.
  const webhook = settings.postAsSharer
    ? await getChannelWebhook(message.channel).catch((err) => {
        console.error(`Couldn't get a webhook in #${message.channel.name}, posting as the bot:`, err.message);
        return null;
      })
    : null;
  let repost;
  try {
    repost = webhook
      ? await sendAll(buildPayloads(message, lines, cards, { header: sharerHeader(message) }), (payload) =>
          sendAsSharer(webhook, message, payload)
        )
      : null;
  } catch (err) {
    if (err.postedAny) throw err;
    console.error('Posting through the webhook failed, posting as the bot instead:', err.message);
    forgetChannelWebhook(message.channel);
  }
  repost ??= await sendAll(buildPayloads(message, lines, cards, { header: botHeader(message) }), (payload) =>
    message.channel.send(payload)
  );

  // The clean version is up, so remove the cluttered original.
  logs.ignoreDeletion(message.id);
  await message.delete().catch((err) => {
    console.error('Fixed embed posted, but could not delete the original message:', err.message);
  });
  return repost;
}

// Sends the payloads in order and returns the first message sent. If a send
// fails after something was already posted, the error says so (postedAny).
async function sendAll(payloads, send) {
  let first = null;
  for (const payload of payloads) {
    try {
      const sent = await send(payload);
      first ??= sent;
    } catch (err) {
      err.postedAny = first !== null;
      throw err;
    }
  }
  return first;
}

// Whatever the person wrote alongside their links, with the links taken out.
function textBesideLinks(message) {
  return ALL_LINK_REGEXES.reduce((text, regex) => text.replace(regex, ''), message.content)
    .replace(/<>/g, '') // left behind by <link> embed-suppression brackets
    .replace(/[ \t]{2,}/g, ' ') // gaps left where links were removed
    .trim();
}

// Posting as the bot: "@user shared:" with their own words quoted under it.
function botHeader(message) {
  const text = textBesideLinks(message);
  return [`<@${message.author.id}> shared:`, ...(text ? text.split('\n').map((line) => `> ${line}`) : [])];
}

// Posting as the sharer: just their own words, as they wrote them.
function sharerHeader(message) {
  const text = textBesideLinks(message);
  return text ? text.split('\n') : [];
}

// The messages to send: plain links first (with the header on top), then one
// message per post card.
function buildPayloads(message, lines, cards, { header }) {
  // Shows mention pills without pinging anyone (including any @everyone that
  // sneaks in via a fetched article title).
  const allowedMentions = { parse: [], repliedUser: false };
  const buttonContext = {
    posterId: message.author.id,
    // Threads can only be started from messages in regular text/announcement channels.
    canStartThreads: [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(message.channel.type),
  };
  // Long text is split across messages, with the buttons on the last one.
  const toPayloads = (contentLines, extras) => {
    const payloads = chunkContent(contentLines).map((chunk) => ({ content: chunk, allowedMentions }));
    if (payloads.length === 0) payloads.push({ allowedMentions });
    Object.assign(payloads.at(-1), extras);
    return payloads;
  };

  const payloads = [];
  // The header goes at the top of the first message. It can only sit inside a
  // card if it fits the card's text limit and has no links of its own (e.g. a
  // link to some other website) - links in a card don't get Discord's preview.
  const headerText = header.join('\n');
  const headerFitsInCard =
    cards.length > 0 &&
    !/(?<!<)https?:\/\//.test(headerText) &&
    headerText.length + cardTextLength(cards[0].components) + 100 <= MAX_CARD_TEXT;
  if (lines.length > 0) {
    payloads.push(...toPayloads([...header, ...lines], { components: linkMessageButtons(lines) }));
  } else if (header.length > 0 && !headerFitsInCard) {
    payloads.push(...toPayloads(header, {}));
  }
  for (const card of cards) {
    const lead = payloads.length === 0 && header.length > 0 ? [new TextDisplayBuilder().setContent(headerText)] : [];
    payloads.push({
      flags: MessageFlags.IsComponentsV2,
      allowedMentions,
      components: [...lead, ...card.components, ...cardButtons(card, buttonContext)],
    });
  }
  return payloads;
}

// The Copy button for a message of plain links, counted the same way the
// button reads them back later.
function linkMessageButtons(lines) {
  const count = fixedLinksIn({ content: lines.join('\n'), embeds: [] }).length;
  return count ? toButtonRows([makeButton('copy-links', count > 1 ? '🔗 Copy links' : '🔗 Copy link')]) : [];
}

// The buttons under a post card: open the post on its platform (and the quoted
// post, for X quotes), copy the fixed link, show top replies (X), and flag as
// NSFW. "Flag as NSFW" is on every card, so moderators or the original poster
// can hide anything; posterId rides along in the customId since the button
// handler runs later with no other way to know who posted it.
function cardButtons(card, { posterId, canStartThreads }) {
  const linkButton = ({ label, url }) => new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(url);
  // A button id over Discord's limit (possible with very long Twitch clip
  // names) would make Discord reject the whole message, so that button is left off.
  const fits = (id) => id.length <= MAX_CUSTOM_ID;
  const flagId = `flag-card:${card.revealKey}:${posterId}`;
  return toButtonRows([
    ...(card.open ? [linkButton(card.open)] : []),
    ...card.extraLinks.map(linkButton),
    ...(fits(card.copyId) ? [makeButton(card.copyId, '🔗 Copy link')] : []),
    ...(canStartThreads && card.repliesId ? [makeButton(`top-replies:${card.repliesId}`, '💬 Show top 3 replies')] : []),
    ...(canStartThreads && card.threadId
      ? [makeButton(`x-thread:${card.threadId}`, `🧵 Show thread (${card.threadLength} posts)`)]
      : []),
    ...(card.downloadId && fits(card.downloadId) ? [makeButton(card.downloadId, '⬇️ Download video')] : []),
    ...(card.translateId ? [makeButton(card.translateId, '🌐 Translate')] : []),
    ...(card.summaryId ? [makeButton(`yt-summary:${card.summaryId}`, '✨ Video Summary')] : []),
    ...(fits(flagId) ? [makeButton(flagId, '🚩 Flag as NSFW')] : []),
  ]);
}

// ---------------------------------------------------------------------------
// Posting as the sharer (webhooks)
// ---------------------------------------------------------------------------

const channelWebhooks = new Map(); // channel id -> Promise<Webhook>
// The name of the bot's own posting webhook in each channel. (Each repost
// still shows the sharer's name - this is only what the channel's
// Integrations list shows.)
const WEBHOOK_NAME = 'Spork';
// What the bot's webhooks were called before - reused and renamed, not duplicated.
const OLD_WEBHOOK_NAMES = ['Cardify', 'Dinner News Station'];

// The bot's own webhook in a channel - created on first use, reused after -
// for posting under the sharer's name. Threads use their parent channel's.
// Null where webhooks aren't possible or the bot lacks Manage Webhooks.
async function getChannelWebhook(channel) {
  const target = channel.isThread() ? channel.parent : channel;
  const webhookChannels = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia];
  if (!target || !webhookChannels.includes(target.type)) return null;
  if (!target.permissionsFor(target.guild.members.me)?.has(PermissionFlagsBits.ManageWebhooks)) return null;

  if (!channelWebhooks.has(target.id)) {
    const pending = (async () => {
      // Only a webhook made for this, named WEBHOOK_NAME - never the test
      // webhook: the bot handles that one's posts, so reposting through it
      // would make the bot pick up its own reposts. Older versions named the
      // webhook after the bot, or used an older name; one of those is renamed
      // and reused, so renaming the bot doesn't leave a stray webhook in
      // every channel.
      const hooks = (await target.fetchWebhooks()).filter(
        (hook) => hook.owner?.id === client.user.id && hook.token && hook.id !== TEST_WEBHOOK_ID
      );
      const existing = hooks.find((hook) => hook.name === WEBHOOK_NAME);
      if (existing) return existing;
      const older = hooks.find((hook) => hook.name === client.user.username || OLD_WEBHOOK_NAMES.includes(hook.name));
      if (older) return older.edit({ name: WEBHOOK_NAME, reason: 'Renamed for Spork' }).catch(() => older);
      return target.createWebhook({
        name: WEBHOOK_NAME,
        avatar: client.user.displayAvatarURL(),
        reason: 'Posts fixed links under the name of whoever shared them',
      });
    })().catch((err) => {
      channelWebhooks.delete(target.id);
      throw err;
    });
    channelWebhooks.set(target.id, pending);
  }
  return channelWebhooks.get(target.id);
}

function forgetChannelWebhook(channel) {
  channelWebhooks.delete(channel.isThread() ? channel.parentId : channel.id);
}

// Discord won't let webhooks use names containing "discord" or "clyde".
// "Nickname (Embed App)" - the name the sharer currently shows in the server,
// marked so it's obvious the bot posted it for them, not the person.
// Webhook names max out at 80 characters and can't contain "discord" or "clyde".
const SHARER_TAG = ' (Embed App)';
function sharerName(message) {
  const name = message.member?.displayName || message.author.displayName || message.author.username || 'Someone';
  return truncate(name.replace(/(disc)(ord)/gi, '$1​$2').replace(/(cl)(yde)/gi, '$1​$2'), 80 - SHARER_TAG.length) + SHARER_TAG;
}

function sendAsSharer(webhook, message, payload) {
  return webhook.send({
    ...payload,
    username: sharerName(message),
    avatarURL: (message.member ?? message.author).displayAvatarURL({ extension: 'png', size: 128 }),
    threadId: message.channel.isThread() ? message.channel.id : undefined,
  });
}

// Packs lines into as few messages as possible under the 2000-character limit,
// hard-splitting any single line that's too long on its own.
function chunkContent(lines) {
  const chunks = [];
  let current = '';
  for (const line of lines) {
    for (let i = 0; i < line.length; i += MAX_CONTENT_LENGTH) {
      const piece = line.slice(i, i + MAX_CONTENT_LENGTH);
      if (current && current.length + 1 + piece.length > MAX_CONTENT_LENGTH) {
        chunks.push(current);
        current = piece;
      } else {
        current = current ? `${current}\n${piece}` : piece;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function makeButton(customId, label) {
  return new ButtonBuilder()
    .setCustomId(customId)
    .setLabel(truncate(label, MAX_BUTTON_LABEL))
    .setStyle(ButtonStyle.Secondary);
}

// Packs buttons into as few rows as possible, 5 per row.
function toButtonRows(buttons) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += MAX_BUTTONS_PER_ROW) {
    rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + MAX_BUTTONS_PER_ROW)));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Link archive
// ---------------------------------------------------------------------------
//
// Every supported link is also copied into a thread per category ("TikTok
// Videos", "YouTube Videos", ...) in that server's LINK_ARCHIVE_CHANNEL_IDS
// channel, credited to the poster with a jump link back to where it was shared.

const archiveChannels = new Map(); // server id -> its archive channel (set at startup)
const archiveThreads = new Map(); // "channel id:thread name" -> Promise<ThreadChannel>
const loggedPrivacySkips = new Set(); // channel ids already logged, so it's said once

async function setUpArchiveChannels() {
  for (const id of LINK_ARCHIVE_CHANNEL_IDS) {
    const channel = await client.channels.fetch(id).catch(() => null);
    if (channel?.type !== ChannelType.GuildText) {
      console.error(`Archive channel ${id} isn't a text channel the bot can see - skipping it.`);
      continue;
    }
    const where = `#${channel.name} in "${channel.guild.name}"`;
    if (archiveChannels.has(channel.guildId)) {
      console.error(`${where} is a second archive channel for that server - skipping it (one per server).`);
      continue;
    }
    const permissions = channel.permissionsFor(channel.guild.members.me);
    const missing = permissions?.missing([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.CreatePublicThreads,
      PermissionFlagsBits.SendMessagesInThreads,
    ]);
    if (!missing || missing.length > 0) {
      console.error(`Missing permissions in ${where}: ${missing?.join(', ') || 'unknown'} - skipping it.`);
      continue;
    }
    if (!permissions.has(PermissionFlagsBits.PinMessages)) {
      console.error(`No Pin Messages permission in ${where} - category messages won't be pinned.`);
    }
    archiveChannels.set(channel.guildId, channel);
    console.log(`Copying shared links into category threads in ${where}.`);

    // Set up every category thread now, so the pinned messages are there from
    // the start. Created in reverse because the pins list shows newest first,
    // so it reads X, TikTok, Instagram, YouTube, News top to bottom.
    for (const name of Object.values(ARCHIVE_THREAD_NAMES).reverse()) {
      await getArchiveThread(channel, name).catch((err) => {
        console.error(`Couldn't set up the "${name}" thread in ${where}:`, err.message);
      });
    }
  }

  const unarchived = client.guilds.cache.filter((guild) => !archiveChannels.has(guild.id));
  if (unarchived.size > 0) {
    console.log(`No archive channel for: ${unarchived.map((guild) => `"${guild.name}"`).join(', ')}.`);
  }
}

// Whether @everyone can see a channel. Private threads never count as public,
// even inside a public channel.
function isPublic(channel) {
  if (channel.type === ChannelType.PrivateThread) return false;
  return Boolean(
    channel.permissionsFor(channel.guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel)
  );
}

// shownIn is the message to link back to: the bot's repost, or the original
// if it's still there.
async function archiveLinks(message, links, shownIn) {
  // Each server's links only go to its own archive (and DMs never get archived).
  const archiveChannel = archiveChannels.get(message.guildId);
  if (!archiveChannel) return;
  // Test posts (the only webhook messages the bot handles) stay out of the archive.
  if (message.webhookId) return;
  // The archive can be the same channel people post links in, but links
  // posted inside its threads are already where they belong.
  if (message.channel.parentId === archiveChannel.id) return;
  // Never copy links out of a private channel into an archive everyone can see.
  if (isPublic(archiveChannel) && !isPublic(message.channel)) {
    if (!loggedPrivacySkips.has(message.channelId)) {
      loggedPrivacySkips.add(message.channelId);
      console.log(`Not archiving links from private #${message.channel.name} into public #${archiveChannel.name}.`);
    }
    return;
  }

  // Playable versions, so videos actually play in the archive threads too.
  const linksByCategory = {
    x: links.tweets.map(([, user, id]) => `https://${FIX_DOMAIN}/${user}/status/${id}`),
    tiktok: links.tiktok.map((link) => link.fixed),
    instagram: links.instagram.map((link) => link.fixed),
    youtube: links.youtube.map((video) => video.url),
    news: links.news,
  };
  const credit = `Shared by <@${message.author.id}> in <#${message.channelId}> • ${shownIn.url}`;
  for (const [category, urls] of Object.entries(linksByCategory)) {
    if (urls.length === 0) continue;
    const lines = [credit, ...urls];
    await postToArchiveThread(archiveChannel, ARCHIVE_THREAD_NAMES[category], lines).catch((err) => {
      console.error(`Couldn't copy ${category} links to the archive:`, err.message);
    });
  }
}

async function postToArchiveThread(archiveChannel, name, lines, isRetry = false) {
  const pending = getArchiveThread(archiveChannel, name);
  const thread = await pending;
  try {
    // Threads auto-archive after a week without posts; reopen before posting.
    if (thread.archived) await thread.setArchived(false);
    for (const content of chunkContent(lines)) {
      await thread.send({ content, allowedMentions: { parse: [] } });
    }
  } catch (err) {
    if (isRetry || err.code !== RESTJSONErrorCodes.UnknownChannel) throw err;
    // Someone deleted the thread since it was cached: forget it and find or
    // recreate it once - unless another post that failed at the same moment
    // already did, so the two don't each create a new one.
    const key = `${archiveChannel.id}:${name}`;
    if (archiveThreads.get(key) === pending) archiveThreads.delete(key);
    await postToArchiveThread(archiveChannel, name, lines, true);
  }
}

// The promise is cached (not just the thread), so links arriving at the same
// moment can't each create their own copy of a new thread.
function getArchiveThread(archiveChannel, name) {
  const key = `${archiveChannel.id}:${name}`;
  if (!archiveThreads.has(key)) {
    const pending = findOrCreateArchiveThread(archiveChannel, name).catch((err) => {
      archiveThreads.delete(key);
      throw err;
    });
    archiveThreads.set(key, pending);
  }
  return archiveThreads.get(key);
}

async function findOrCreateArchiveThread(archiveChannel, name) {
  return (await findArchiveThread(archiveChannel, name)) ?? createArchiveThread(archiveChannel, name);
}

// Each category thread hangs off a pinned "anchor" message, so the channel's
// pins double as a menu of the categories.
function anchorText(name) {
  return `📌 **${name}** - every one shared in this server is collected in this message's thread.`;
}

async function createArchiveThread(archiveChannel, name) {
  const anchor = await archiveChannel.send({ content: anchorText(name), allowedMentions: { parse: [] } });
  await anchor.pin(`Link archive: ${name}`).catch((err) => {
    console.error(`Couldn't pin the "${name}" message in #${archiveChannel.name}:`, err.message);
  });
  return anchor.startThread({
    name,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    reason: 'Link archive category',
  });
}

// Finds a category's existing thread, so restarting the bot never creates a
// duplicate. The pinned anchor is checked first: a thread that went quiet
// auto-archives after a week and can end up buried among the channel's other
// threads, but its anchor stays pinned. Falls back to any thread with the same
// name (e.g. if someone unpinned the anchor).
async function findArchiveThread(archiveChannel, name) {
  const anchorStart = `📌 **${name}**`;
  let before;
  for (let page = 0; page < 10; page++) {
    const { items, hasMore } = await archiveChannel.messages.fetchPins({ before, limit: 50 });
    const anchor = items
      .map((item) => item.message)
      .find((message) => message.author.id === client.user.id && message.content.startsWith(anchorStart));
    if (anchor) {
      // A thread started from a message shares its id. If the thread was
      // deleted, unpin its leftover anchor so a fresh one can take its place.
      const thread = await archiveChannel.threads.fetch(anchor.id).catch(() => null);
      if (thread) return thread;
      await anchor.unpin().catch(() => {});
      break;
    }
    if (!hasMore || items.length === 0) break;
    before = items.at(-1).pinnedTimestamp;
  }

  const { threads: active } = await archiveChannel.threads.fetchActive();
  const { threads: archived } = await archiveChannel.threads.fetchArchived({ type: 'public', limit: 100 });
  return [...active.values(), ...archived.values()].find((thread) => thread.name === name) ?? null;
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

const DELETED_OR_PRIVATE = 'it may have been deleted or made private.';
const FLAG_FAILED = "Couldn't flag that post - something went wrong editing the message.";
// flag-nsfw, flag-nsfw-link, reveal-nsfw and reveal-nsfw-link are the buttons on
// messages from older versions of the bot, which used embeds and plain links.
const BUTTON_HANDLERS = {
  'copy-x': { run: copyPostLink, failMessage: "Couldn't get that post's link." },
  'copy-fix': { run: copyFixerLink, failMessage: "Couldn't get that post's link." },
  'copy-tw': { run: copyTwitchLink, failMessage: "Couldn't get that link." },
  'copy-yt': { run: copyYouTubeLink, failMessage: "Couldn't get that link." },
  'watch-yt': { run: watchOnDiscord, failMessage: "Couldn't open that video." },
  role: { run: (interaction, roleId) => roles.handleButton(interaction, roleId), failMessage: "Couldn't change your role - try again in a moment." },
  music: { run: (interaction, action) => music.handleButton(interaction, action), failMessage: "Couldn't do that - try again in a moment." },
  vc: { run: (interaction, action) => tempVoice.handleButton(interaction, action), failMessage: "Couldn't change the channel - I may be missing the Manage Roles permission." },
  'x-thread': { run: postThread, failMessage: `Couldn't post the thread - ${DELETED_OR_PRIVATE}` },
  dl: { run: downloadVideo, failMessage: `Couldn't get the video - ${DELETED_OR_PRIVATE}` },
  'translate-x': { run: translatePost, failMessage: "Couldn't translate that post right now - try again in a moment." },
  'watch-together': { run: watchTogether, failMessage: "Couldn't start Watch Together - try again in a moment." },
  'yt-summary': { run: showVideoSummary, failMessage: "Couldn't get that video's summary." },
  'flag-card': { run: flagCard, failMessage: FLAG_FAILED },
  'unflag-card': { run: unflagCard, failMessage: "Couldn't undo the flag - something went wrong editing the message." },
  'reveal-card': { run: revealCard, failMessage: `Couldn't fetch that post - ${DELETED_OR_PRIVATE}` },
  'copy-links': { run: copyLinks, failMessage: "Couldn't get the links from that message." },
  'top-replies': { run: postTopReplies, failMessage: `Couldn't post the replies - ${DELETED_OR_PRIVATE}` },
  'reveal-nsfw': { run: revealEmbed, failMessage: `Couldn't fetch that post - ${DELETED_OR_PRIVATE}` },
  'reveal-nsfw-link': { run: revealLink, failMessage: "Couldn't reveal that video." },
  'flag-nsfw': { run: flagEmbed, failMessage: FLAG_FAILED },
  'flag-nsfw-link': { run: flagLink, failMessage: FLAG_FAILED },
};

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.guildId && !isAllowedServer(interaction.guildId)) return;
  // Switched-off features, quiet channels, and /access role and channel limits.
  if (interaction.isChatInputCommand()) {
    const problem = access.commandProblem(interaction);
    if (problem) {
      await interaction.reply({ content: problem, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});
      return;
    }
  }
  if (interaction.isMessageComponent()) {
    const prefix = interaction.customId.split(':')[0];
    if (prefix === 'help' || prefix === 'setup' || prefix === 'access') {
      await (prefix === 'help' ? help : setup).handleComponent(interaction).catch(async (err) => {
        console.error(`${interaction.customId} failed:`, err);
        await replyPrivately(interaction, 'Something went wrong - try again in a moment.').catch(() => {});
      });
      return;
    }
    const feature = COMPONENT_FEATURES[prefix];
    const problem = feature && access.componentProblem(interaction, feature);
    if (problem) {
      await interaction.reply({ content: problem, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});
      return;
    }
  }
  if (interaction.isChatInputCommand() && interaction.commandName === EMBEDS_COMMAND.name) {
    try {
      await handleEmbedsCommand(interaction);
    } catch (err) {
      console.error('/embeds failed:', err);
      await replyPrivately(interaction, "Couldn't change that setting - check the bot's log.").catch(() => {});
    }
    return;
  }
  if (interaction.isAutocomplete()) {
    for (const feature of FEATURES) {
      if (await feature.handleAutocomplete?.(interaction).catch((err) => console.error(`/${interaction.commandName} suggestions failed:`, err))) return;
    }
    return;
  }
  if (interaction.isChatInputCommand()) {
    try {
      for (const feature of FEATURES) if (await feature.handleCommand(interaction)) return;
    } catch (err) {
      console.error(`/${interaction.commandName} failed:`, err);
      await replyPrivately(interaction, 'Something went wrong - check the bot\'s log.').catch(() => {});
    }
    return;
  }
  if (interaction.isStringSelectMenu() && interaction.customId === 'role-menu') {
    await roles.handleSelect(interaction).catch(async (err) => {
      console.error('Role menu failed:', err);
      await replyPrivately(interaction, "Couldn't change your roles - try again in a moment.").catch(() => {});
    });
    return;
  }
  if (!interaction.isButton()) return;
  // customIds look like "action:arg1:arg2..." - see the makeButton calls above.
  const [action, ...args] = interaction.customId.split(':');
  const handler = BUTTON_HANDLERS[action];
  if (!handler) return;
  try {
    await handler.run(interaction, ...args);
  } catch (err) {
    console.error(`Button ${interaction.customId} failed:`, err);
    await replyPrivately(interaction, handler.failMessage).catch(() => {});
  }
});

// Replies only to whoever clicked, whatever state the interaction is in. After
// deferUpdate (see postTopReplies), editReply would overwrite the clicked
// message itself, so that case gets a private follow-up instead.
function replyPrivately(interaction, content) {
  if (interaction.deferred && !interaction.deferredAsUpdate) return interaction.editReply({ content });
  const payload = { content, flags: MessageFlags.Ephemeral };
  return interaction.deferred || interaction.replied ? interaction.followUp(payload) : interaction.reply(payload);
}

// Rebuilds a message's components with `transform` applied to one button,
// leaving every other button - and, on card messages, the cards - untouched.
function replaceButton(message, customId, transform) {
  return message.components.map((component) => {
    if (component.type !== ComponentType.ActionRow) return component.toJSON?.() ?? component;
    return new ActionRowBuilder().addComponents(
      component.components.map((child) => {
        const button = ButtonBuilder.from(child);
        return button.data.custom_id === customId ? transform(button) : button;
      })
    );
  });
}

// The fixed link for everything shared in one of the bot's messages, read
// back from the message itself so it still works after a restart: fixer,
// archive, and bypass links from its text, plus fxtwitter links for X posts
// shown as embeds. Quoted posts are left out - they aren't what was shared,
// and the main post's fixed link shows the quote anyway.
function fixedLinksIn(message) {
  const fromText = message.content
    .split('\n')
    .filter((line) => !line.includes(QUOTE_LABEL))
    .flatMap((line) => line.match(FIXED_LINK_REGEX) ?? []);
  const fromEmbeds = message.embeds
    .filter((embed) => embed.author?.url && !embed.author.name?.startsWith(QUOTE_LABEL))
    .map((embed) => embed.author.url.match(/\/(\w+)\/status\/(\d+)/))
    .filter(Boolean)
    .map(([, user, id]) => `https://${FIX_DOMAIN}/${user}/status/${id}`);
  return [...new Set([...fromText, ...fromEmbeds])];
}

// Discord doesn't let bots put anything on the clipboard, so the closest thing
// is a private reply holding only the fixed links, with previews off - then a
// long-press (mobile) or right-click (desktop) copies a link.
async function copyLinks(interaction) {
  const links = fixedLinksIn(interaction.message);
  if (links.length === 0) {
    return replyPrivately(interaction, "Couldn't find any links in that message.");
  }
  const flags = [MessageFlags.Ephemeral, MessageFlags.SuppressEmbeds];
  const [first, ...rest] = chunkContent(links);
  await interaction.reply({ content: first, flags });
  for (const content of rest) await interaction.followUp({ content, flags });
}

// Copy link on an X post card: the post's fixed link, privately, preview off.
async function copyPostLink(interaction, user, id) {
  await interaction.reply({
    content: `https://${FIX_DOMAIN}/${user}/status/${id}`,
    flags: [MessageFlags.Ephemeral, MessageFlags.SuppressEmbeds],
  });
}

// Copy link on a TikTok or Instagram card: the post's fixer link.
async function copyFixerLink(interaction, platform, kind, id) {
  const url =
    platform === 'tt' ? `https://${TIKTOK_FIX_DOMAIN}/@i/${kind}/${id}` : `https://${INSTAGRAM_FIX_DOMAIN}/${kind}/${id}/`;
  await interaction.reply({ content: url, flags: [MessageFlags.Ephemeral, MessageFlags.SuppressEmbeds] });
}

// Copy link on a Twitch or YouTube card: the clean link (neither needs a fixer).
async function copyTwitchLink(interaction, kind, id) {
  await interaction.reply({ content: twitchUrl(kind, id), flags: [MessageFlags.Ephemeral, MessageFlags.SuppressEmbeds] });
}

async function copyYouTubeLink(interaction, kind, id) {
  await interaction.reply({ content: youtubeUrl(kind, id), flags: [MessageFlags.Ephemeral, MessageFlags.SuppressEmbeds] });
}

// "Watch on Discord" on a YouTube card: the video's link, privately to whoever
// clicked - Discord shows its own YouTube player under a plain link, so the
// video plays right in Discord (a card can't hold that player).
async function watchOnDiscord(interaction, id, time) {
  await interaction.reply({ content: youtubeUrl('video', id, time || null), flags: MessageFlags.Ephemeral });
}

// Discord's own "Watch Together" activity - YouTube, full-size and in sync for
// everyone in a voice channel.
const WATCH_TOGETHER_APP_ID = '880218394199220334';

// "Watch Together" on a YouTube card: privately gives whoever clicked an
// invite that opens Watch Together in the voice channel they're in, plus the
// video's link to paste into it (Discord doesn't let bots pick the video).
async function watchTogether(interaction, id, time) {
  if (!interaction.inGuild()) {
    await replyPrivately(interaction, 'Watch Together only works in a server, in a voice channel.');
    return;
  }
  const voice = interaction.guild?.voiceStates.cache.get(interaction.user.id)?.channel;
  if (!voice) {
    await replyPrivately(
      interaction,
      'Join a voice channel first, then click **📺 Watch Together** again - it opens YouTube there for everyone in the call.'
    );
    return;
  }
  if (!voice.permissionsFor(interaction.guild.members.me)?.has(PermissionFlagsBits.CreateInstantInvite)) {
    await replyPrivately(interaction, `I don't have permission to create invites in <#${voice.id}>, so I can't start Watch Together there.`);
    return;
  }
  const invite = await voice.createInvite({
    maxAge: 60 * 60,
    targetType: InviteTargetType.EmbeddedApplication,
    targetApplication: WATCH_TOGETHER_APP_ID,
    reason: `Watch Together for a YouTube video, started by ${interaction.user.tag}`,
  });
  await replyPrivately(
    interaction,
    [
      `📺 **Watch Together in <#${voice.id}>:** ${invite.url}`,
      "Once it opens, paste this video's link into it:",
      // In <> so Discord doesn't add another preview of the video.
      `<${youtubeUrl('video', id, time || null)}>`,
    ].join('\n')
  );
}

// "Video Summary" on a YouTube card: YouTube's AI summary of the video, privately.
async function showVideoSummary(interaction, id) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const video = await fetchYouTube(id);
  if (!video.summary) {
    await interaction.editReply({ content: "YouTube doesn't have a summary for this video right now." });
    return;
  }
  const summary = new ContainerBuilder()
    .setAccentColor(YOUTUBE_COLOR)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          '### ✨ Video Summary',
          `**${escapeMarkdown(truncate(video.title, 300))}**`,
          escapeMarkdown(truncate(video.summary, 3000)),
          '-# Written by YouTube\'s AI - it can make mistakes.',
        ].join('\n')
      )
    );
  await interaction.editReply({ flags: MessageFlags.IsComponentsV2, components: [summary] });
}

// Hides a post card (text and media - for X quotes, both posts) for the whole
// channel, keeping only the header text above it, and swaps the flag button
// for a per-user Reveal button plus an "Undo flag" button in case it was a
// mistake. The card is saved first (flagged.js), so Undo can put it back
// exactly as it was. `key` is the card's revealKey.
async function flagCard(interaction, key, posterId) {
  if (!(await ensureCanFlag(interaction, posterId))) return;
  const components = interaction.message.components;
  const firstCard = components.findIndex((c) => c.type === ComponentType.Container);
  const header = components.slice(0, Math.max(firstCard, 0)).filter((c) => c.type === ComponentType.TextDisplay);
  const notice = new ContainerBuilder()
    .setAccentColor(NOTICE_COLOR)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `🚩 **Flagged as NSFW** - hidden by <@${interaction.user.id}>.\n-# Use Reveal to see it privately.`
      )
    );
  // Only the buttons under the card are kept (a YouTube card's Watch buttons
  // are inside it, so they're hidden with it). Re-packed into rows, since the
  // extra Undo button can overflow a full row.
  const buttons = components
    .filter((c) => c.type === ComponentType.ActionRow)
    .flatMap((row) => row.components.map((child) => ButtonBuilder.from(child)))
    .flatMap((button) =>
      button.data.custom_id === interaction.customId
        ? [
            new ButtonBuilder().setCustomId(`reveal-card:${key}`).setLabel('🔞 Reveal').setStyle(ButtonStyle.Danger),
            makeButton(`unflag-card:${posterId}`, '↩️ Undo flag'),
          ]
        : [button]
    );

  saveFlaggedCard(interaction.message.id, components.map((c) => c.toJSON?.() ?? c));
  await interaction.update({
    flags: MessageFlags.IsComponentsV2,
    components: [...header.map((c) => c.toJSON?.() ?? c), notice, ...toButtonRows(buttons)],
    allowedMentions: { parse: [] },
  });
  await interaction.followUp({ content: 'Flagged as NSFW and hidden.', flags: MessageFlags.Ephemeral });
}

// "Undo flag": puts a flagged card back exactly as it was before it was
// flagged. Same people as flagging - moderators or whoever shared it.
async function unflagCard(interaction, posterId) {
  if (!(await ensureCanFlag(interaction, posterId, 'undo the flag on it'))) return;
  const original = getFlaggedCard(interaction.message.id);
  if (!original) {
    await replyPrivately(interaction, "Couldn't find this post's original card to put back - use Reveal to see it.");
    return;
  }
  await interaction.update({ flags: MessageFlags.IsComponentsV2, components: original, allowedMentions: { parse: [] } });
  forgetFlaggedCard(interaction.message.id);
  await interaction.followUp({ content: 'Flag undone - the post is showing again.', flags: MessageFlags.Ephemeral });
}

// Per-user and repeatable: shows a flagged post card only to whoever clicks.
async function revealCard(interaction, key) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const components = await loadCardComponents(key, interaction.guildId);
  await interaction.editReply({ flags: MessageFlags.IsComponentsV2, components });
}

// Used by the one-shot thread button, so it can't post duplicates. Needs the
// interaction to have been acknowledged with deferUpdate: editReply then edits
// the clicked message itself - which also works when it was posted through a
// webhook, where the bot couldn't edit it directly.
async function disableClickedButton(interaction, label) {
  const components = replaceButton(interaction.message, interaction.customId, (button) =>
    button.setDisabled(true).setLabel(label)
  );
  const isCard = interaction.message.components.some((c) => c.type !== ComponentType.ActionRow);
  await interaction.editReply({ components, ...(isCard && { flags: MessageFlags.IsComponentsV2 }) }).catch((err) => {
    console.error("Couldn't disable the clicked button:", err.message);
  });
}

// Closes (archives and locks) the bot's reply threads once they're 24 hours
// old - see REPLY_THREAD_LIFETIME_MS. Other threads, like the link archive's
// category threads, are left alone.
async function closeOldReplyThreads() {
  let closed = 0;
  for (const guild of client.guilds.cache.values()) {
    const active = await guild.channels.fetchActiveThreads().catch((err) => {
      console.error(`Couldn't list threads in "${guild.name}":`, err.message);
      return null;
    });
    for (const thread of active?.threads.values() ?? []) {
      // Threads from before 2022 have no recorded opening time; their id's is close enough.
      const openedAt = thread.createdTimestamp ?? SnowflakeUtil.timestampFrom(thread.id);
      const isOldReplyThread =
        thread.ownerId === client.user.id &&
        REPLY_THREAD_NAME.test(thread.name) &&
        Date.now() - openedAt >= REPLY_THREAD_LIFETIME_MS;
      if (!isOldReplyThread) continue;
      try {
        await thread.edit({ archived: true, locked: true, reason: 'Reply threads close 24 hours after opening' });
        closed++;
      } catch (err) {
        console.error(`Couldn't close thread "${thread.name}" in "${guild.name}":`, err.message);
      }
    }
  }
  if (closed > 0) console.log(`Closed ${closed} reply thread(s) that were over 24 hours old.`);
}

async function getOrCreateThread(message, name) {
  if (message.thread) return message.thread;
  // A thread started from a message shares its id.
  if (message.hasThread) return message.channel.threads.fetch(message.id);
  return message.startThread({ name, autoArchiveDuration: ThreadAutoArchiveDuration.OneDay });
}

// Posts the 3 most-liked replies into a public thread on the message; status
// messages are private to whoever clicked.
async function postTopReplies(interaction, tweetId) {
  await interaction.deferUpdate();
  interaction.deferredAsUpdate = true;
  const replies = await fetchTopReplies(tweetId, 3);
  if (replies.length === 0) return replyPrivately(interaction, 'No replies found on that post.');

  const thread = await getOrCreateThread(interaction.message, `Top replies (${replies.length})`);
  for (const [i, reply] of replies.entries()) {
    // Video replies get a fixer link, same as everywhere else.
    const payload = reply.media?.videos?.length
      ? { content: `**#${i + 1}** https://${FIX_DOMAIN}/${reply.author?.screen_name || 'i'}/status/${reply.id}` }
      : { content: `**#${i + 1}**`, embeds: [buildTweetEmbed(reply)] };
    await thread.send(payload);
  }

  await disableClickedButton(interaction, '✅ Replies posted');
  await replyPrivately(interaction, `Posted the top ${replies.length} replies in the thread.`);
}

// "Show thread" on an X post: posts the author's whole thread, in order, into
// a public Discord thread on the message (closed after 24 hours, like replies).
async function postThread(interaction, tweetId) {
  await interaction.deferUpdate();
  interaction.deferredAsUpdate = true;
  const posts = authorThread(await fetchFxtwitter(`conversation/${tweetId}`));
  if (posts.length < 2) return replyPrivately(interaction, "That post isn't part of a thread anymore.");

  const shown = posts.slice(0, MAX_THREAD_POSTS);
  const thread = await getOrCreateThread(interaction.message, `Thread (${posts.length} posts)`);
  for (const [i, post] of shown.entries()) {
    const number = `**${i + 1}/${posts.length}**`;
    // Video posts get a fixer link, same as everywhere else.
    const payload = post.media?.videos?.length
      ? { content: `${number} https://${FIX_DOMAIN}/${post.author?.screen_name || 'i'}/status/${post.id}` }
      : { content: number, embeds: [buildTweetEmbed(post)] };
    await thread.send(payload);
  }
  if (posts.length > shown.length) {
    await thread.send({ content: `…and ${posts.length - shown.length} more on X: <${posts.at(-1).url}>` });
  }

  await disableClickedButton(interaction, '✅ Thread posted');
  await replyPrivately(interaction, `Posted the ${posts.length}-post thread.`);
}

// "Download video": the post's video file(s), privately - opening one shows it
// in Discord's player, where it can be saved. Links are fetched fresh, since
// some (Twitch clips) expire.
async function downloadVideo(interaction, platform, id) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  let urls = [];
  if (platform === 'x') {
    const tweet = await fetchTweet(id);
    urls = [...postVideoUrls(tweet), ...postVideoUrls(tweet.quote)];
  } else if (platform === 'tt') {
    urls = fixerVideoUrls(await fetchFixerStatus(TIKTOK_FIX_DOMAIN, id));
  } else if (platform === 'ig') {
    urls = fixerVideoUrls(await fetchFixerStatus(INSTAGRAM_FIX_DOMAIN, id));
  } else if (platform === 'tw') {
    urls = [twitchClipVideo(await fetchTwitch('clip', id))].filter(Boolean);
  }
  if (urls.length === 0) {
    await interaction.editReply({ content: "Couldn't find a video in that post anymore." });
    return;
  }
  const lines = urls.length === 1 ? urls : urls.map((url, i) => `**${i + 1}.** ${url}`);
  await interaction.editReply({ content: ['⬇️ Open the video, then save it from there:', ...lines].join('\n') });
}

// The video behind an X, TikTok, Instagram or Twitch clip link, for the music
// player to play its sound: { url, title, link }. Null when the text has no
// such link, or the post has no video.
async function clipAudioFor(text) {
  const links = findLinks(text);
  const short = (caption) => truncate(htmlToText(caption ?? '').replace(/\s+/g, ' '), 80);
  if (links.tweets.length) {
    const tweet = await fetchTweet(links.tweets[0][2]);
    const url = [...postVideoUrls(tweet), ...postVideoUrls(tweet.quote)][0];
    const by = tweet.author?.screen_name ? `@${tweet.author.screen_name}` : 'X post';
    return url ? { url, title: tweet.text ? `${by}: ${short(tweet.text)}` : by, link: tweet.url } : null;
  }
  if (links.tiktok.length || links.instagram.length) {
    const isTikTok = links.tiktok.length > 0;
    const original = (isTikTok ? links.tiktok : links.instagram)[0].original;
    const id = isTikTok ? (await resolveTikTokLink(original)).id : parseInstagramLink(original)?.code;
    if (!id) return null;
    const status = await fetchFixerStatus(isTikTok ? TIKTOK_FIX_DOMAIN : INSTAGRAM_FIX_DOMAIN, id);
    const url = fixerVideoUrls(status)[0];
    const by = status.account?.username ? `@${status.account.username}` : isTikTok ? 'TikTok' : 'Instagram';
    return url ? { url, title: status.content ? `${by}: ${short(status.content)}` : by, link: status.url || original } : null;
  }
  const clip = links.twitch.find((link) => link.kind === 'clip');
  if (clip) {
    const data = await fetchTwitch('clip', clip.id);
    const url = twitchClipVideo(data);
    return url ? { url, title: data.title || 'Twitch clip', link: clip.url } : null;
  }
  return null;
}

// "Translate" on an X post: the post (and the post it quotes) translated into
// the clicker's own Discord language, privately.
async function translatePost(interaction, tweetId) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const language = (interaction.locale || 'en').split('-')[0].toLowerCase();
  const tweet = await fetchTweet(tweetId, { lang: language });
  const quote = tweet.quote?.type === 'tombstone' ? null : tweet.quote;
  const translated = [tweet, quote].filter((post) => post?.translation?.text);
  if (translated.length === 0) {
    const already = !needsTranslation(tweet.lang, language);
    await interaction.editReply({
      content: already ? 'That post is already in your language.' : "X couldn't translate that post right now.",
    });
    return;
  }
  const text = translated
    .map((post) => {
      const from = post.translation.source_lang_en || post.translation.source_lang || 'another language';
      const heading = post === quote ? '### ↪ Quoted post\n' : '';
      return `${heading}-# 🌐 Translated from ${from}\n${truncate(post.translation.text, 1800)}`;
    })
    .join('\n\n');
  const card = new ContainerBuilder()
    .setAccentColor(X_POST_COLOR)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`### 𝕏  ·  ${postNameLine(tweet)}\n${text}`));
  await interaction.editReply({ flags: MessageFlags.IsComponentsV2, components: [card] });
}

// Flagging hides a post for the whole channel, so in servers it's limited to
// moderators and whoever originally shared the link. (In DMs, only the two
// participants can click anyway.)
async function ensureCanFlag(interaction, posterId, action = 'flag it as NSFW') {
  const allowed =
    !interaction.inGuild() ||
    interaction.user.id === posterId ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages);
  if (!allowed) {
    await replyPrivately(interaction, `Only a moderator or the person who originally shared this can ${action}.`);
  }
  return allowed;
}

// Redacts the image *and* text (NSFW content can be text-only), and swaps the
// flag button for a per-user "Reveal" button.
async function flagEmbed(interaction, _platform, id, embedIndex, posterId) {
  if (!(await ensureCanFlag(interaction, posterId))) return;
  const index = Number(embedIndex);
  const { embeds } = interaction.message;
  if (!embeds[index]) return replyPrivately(interaction, "Couldn't find that embed anymore.");

  const hiddenEmbed = EmbedBuilder.from(embeds[index])
    .setImage(null)
    .setDescription('*Content hidden - flagged as NSFW.*')
    .setFields({ name: '🚩 Flagged as NSFW', value: `Hidden by <@${interaction.user.id}>` });

  await interaction.update({
    embeds: embeds.map((embed, i) => (i === index ? hiddenEmbed : embed)),
    // The embed index keeps this unique if the same post appears twice.
    components: replaceButton(interaction.message, interaction.customId, () =>
      new ButtonBuilder()
        .setCustomId(`reveal-nsfw:x:${id}:${index}`)
        .setLabel('🔞 Reveal image')
        .setStyle(ButtonStyle.Danger)
    ),
  });
  await interaction.followUp({ content: 'Flagged as NSFW and hidden.', flags: MessageFlags.Ephemeral });
}

// Video posts have no bot-built embed - the preview is Discord's own unfurl of
// a link in the message text - so flagging wraps that link in <angle
// brackets>, Discord's syntax for "don't preview this link".
async function flagLink(interaction, _platform, id, posterId) {
  if (!(await ensureCanFlag(interaction, posterId))) return;
  // Skips links that are already wrapped, and requires the id to end there so
  // /status/123 can't also match /status/1234.
  const linkPattern = new RegExp(
    `(?<!<)https?://[^\\s<>]+/status(?:es)?/${escapeRegex(id)}(?!\\w)[^\\s<>]*`,
    'gi'
  );
  const { content } = interaction.message;
  if (!content.match(linkPattern)) {
    return replyPrivately(interaction, "Couldn't find that link in the message anymore.");
  }

  const note = `🚩 **Flagged as NSFW** by <@${interaction.user.id}> - video hidden.`;
  let newContent = content.replace(linkPattern, (url) => `${note} <${url}>`);
  // If the note would push the message over Discord's limit, just hide the link.
  if (newContent.length > MAX_CONTENT_LENGTH) {
    newContent = content.replace(linkPattern, (url) => `<${url}>`);
  }

  await interaction.update({
    content: newContent,
    components: replaceButton(interaction.message, interaction.customId, () =>
      new ButtonBuilder()
        .setCustomId(`reveal-nsfw-link:x:${id}`)
        .setLabel('🔞 Reveal video')
        .setStyle(ButtonStyle.Danger)
    ),
    allowedMentions: { parse: [] },
  });
  await interaction.followUp({ content: 'Flagged as NSFW and hidden.', flags: MessageFlags.Ephemeral });
}

// Per-user and repeatable: shows a flagged post only to whoever clicks, while
// it stays hidden for everyone else.
async function revealEmbed(interaction, _platform, id) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const embed = buildTweetEmbed(await fetchTweet(id));
  await interaction.editReply({ content: 'Visible only to you:', embeds: [embed] });
}

// A plain link in a private reply, so Discord's own unfurl plays the video
// just for whoever clicked.
async function revealLink(interaction, _platform, id) {
  await replyPrivately(interaction, `Visible only to you:\nhttps://${FIX_DOMAIN}/i/status/${id}`);
}

// ---------------------------------------------------------------------------
// /embeds - settings for server admins (see settings.js)
// ---------------------------------------------------------------------------

// Languages offered for translation (Discord allows at most 25 choices).
const TRANSLATION_LANGUAGES = [
  ['English', 'en'], ['Spanish', 'es'], ['Portuguese', 'pt'], ['French', 'fr'], ['German', 'de'],
  ['Italian', 'it'], ['Dutch', 'nl'], ['Polish', 'pl'], ['Russian', 'ru'], ['Ukrainian', 'uk'],
  ['Turkish', 'tr'], ['Arabic', 'ar'], ['Hebrew', 'he'], ['Persian', 'fa'], ['Hindi', 'hi'],
  ['Japanese', 'ja'], ['Korean', 'ko'], ['Chinese', 'zh'], ['Indonesian', 'id'], ['Vietnamese', 'vi'],
  ['Thai', 'th'], ['Swedish', 'sv'], ['Filipino', 'tl'], ['Greek', 'el'], ["Don't translate", 'off'],
];

const EMBEDS_COMMAND = new SlashCommandBuilder()
  .setName('embeds')
  .setDescription('Settings for how this bot fixes shared links')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) => sub.setName('status').setDescription("Show this server's and this channel's settings"))
  .addSubcommand((sub) =>
    sub
      .setName('channel')
      .setDescription('Turn link fixing on or off in this channel (and its threads)')
      .addBooleanOption((option) => option.setName('enabled').setDescription('Fix links in this channel?').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub
      .setName('language')
      .setDescription('The language posts get translated into')
      .addStringOption((option) =>
        option
          .setName('language')
          .setDescription('Translate posts into...')
          .setRequired(true)
          .addChoices(...TRANSLATION_LANGUAGES.map(([name, value]) => ({ name, value })))
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('post-as')
      .setDescription('Post fixed links as the person who shared them, or as the bot')
      .addStringOption((option) =>
        option
          .setName('who')
          .setDescription('Who fixed links are posted as')
          .setRequired(true)
          .addChoices(
            { name: 'The person who shared the link', value: 'sharer' },
            { name: 'The bot, with a "shared:" line', value: 'bot' }
          )
      )
  );

async function handleEmbedsCommand(interaction) {
  // Discord hides /embeds from people without Manage Server by default, but a
  // server's admins can change that in Server Settings > Integrations - so the
  // bot checks for itself too.
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      content: 'Only people with the **Manage Server** permission can use /embeds.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const subcommand = interaction.options.getSubcommand();
  // Threads follow their channel's setting.
  const channelId = interaction.channel?.isThread() ? interaction.channel.parentId : interaction.channelId;
  let settings = getGuildSettings(interaction.guildId);
  let changed = '';
  let logged = ''; // the change, for the log

  if (subcommand === 'channel') {
    const enabled = interaction.options.getBoolean('enabled', true);
    const disabled = new Set(settings.disabledChannels);
    if (enabled) disabled.delete(channelId);
    else disabled.add(channelId);
    settings = updateGuildSettings(interaction.guildId, { disabledChannels: [...disabled] });
    changed = `Link fixing is now **${enabled ? 'on' : 'off'}** in <#${channelId}> and its threads.`;
    logged = `turned link fixing ${enabled ? 'on' : 'off'} in channel ${channelId}`;
  } else if (subcommand === 'language') {
    settings = updateGuildSettings(interaction.guildId, { language: interaction.options.getString('language', true) });
    changed = 'Translation language updated.';
    logged = `set the translation language to "${settings.language}"`;
  } else if (subcommand === 'post-as') {
    settings = updateGuildSettings(interaction.guildId, { postAsSharer: interaction.options.getString('who', true) === 'sharer' });
    changed = 'Updated who fixed links are posted as.';
    logged = `set fixed links to post as ${settings.postAsSharer ? 'the person who shared them' : 'the bot'}`;
  }
  // Every settings change is logged with who made it (logs/bot.log has the time).
  if (logged) {
    const who = `${interaction.user?.tag ?? 'someone'} (${interaction.user?.id ?? '?'})`;
    console.log(`/embeds: ${who} ${logged} in "${interaction.guild?.name ?? interaction.guildId}".`);
  }

  const languageName = TRANSLATION_LANGUAGES.find(([, code]) => code === settings.language)?.[0] ?? settings.language;
  const archive = archiveChannels.get(interaction.guildId);
  const status = [
    `**Link fixing in <#${channelId}>:** ${settings.disabledChannels.includes(channelId) ? 'off' : 'on'}`,
    `**Fixed links are posted as:** ${settings.postAsSharer ? 'the person who shared them' : 'the bot, with a "shared:" line'}`,
    `**Posts are translated into:** ${settings.language === 'off' ? 'nothing (translation is off)' : languageName}`,
    `**Link archive:** ${archive ? `<#${archive.id}>` : 'not set up for this server'}`,
    `-# Bot version ${BOT_VERSION}`,
  ].join('\n');
  await interaction.reply({
    content: [changed, status].filter(Boolean).join('\n\n'),
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

// Mirrors everything the bot prints into logs/bot.log with timestamps, so its
// logs can be read no matter where it was started. Keeps one older log once
// the file gets big, instead of growing forever.
function startLogFile() {
  const logFile = path.join(__dirname, 'logs', 'bot.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  if (fs.existsSync(logFile) && fs.statSync(logFile).size > 5 * 1024 * 1024) {
    fs.renameSync(logFile, `${logFile}.1`);
  }
  const stream = fs.createWriteStream(logFile, { flags: 'a' });
  for (const level of ['log', 'error']) {
    const print = console[level].bind(console);
    console[level] = (...args) => {
      print(...args);
      stream.write(`${new Date().toISOString()} ${level === 'error' ? 'ERROR ' : ''}${util.format(...args)}\n`);
    };
  }
  process.on('uncaughtException', (err) => {
    console.error('Crashed:', err);
    process.exit(1);
  });
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag} - version ${BOT_VERSION}`);
  await restart.announceBack(readyClient, BOT_VERSION);
  await leaveUnlistedServers();
  if (TEST_WEBHOOK_ID) console.log('Test webhook posts (test/live.js) are handled like normal messages.');
  // Global command, so it shows up in every server the bot is in.
  const allCommands = [EMBEDS_COMMAND, ...FEATURES.flatMap((feature) => feature.commands)];
  help.init({ commands: allCommands });
  await client.application?.commands.set(allCommands).catch((err) => {
    console.error(
      "Couldn't register the /embeds command (the bot may need re-inviting with the applications.commands scope):",
      err.message
    );
  });
  logs.init(client);
  welcome.init({ membersIntentOn: () => client.options.intents.has(GatewayIntentBits.GuildMembers) });
  // The music player plays the sound of the same clips the cards show.
  music.init({
    client,
    request,
    clipAudioFor,
    youtubeVideo: async (id) => {
      const video = await fetchYouTube(id);
      return { title: video.title, seconds: video.seconds ?? null, live: video.live === 'live', ageRestricted: video.ageRestricted };
    },
  });
  // yt-dlp (YouTube and Spotify audio): downloaded once, then kept up to date.
  if (isMainProgram) ytdlp.start();
  // Join to Create: tidy up channels that emptied while the bot was offline.
  await tempVoice.init(client).catch((err) => console.error('Join to Create startup cleanup failed:', err));
  // Alerts reuse the Twitch and YouTube cards from this file.
  alerts.init({
    client,
    isAllowedServer,
    request,
    decodeHtmlEntities,
    fetchTwitch,
    buildTwitchCard,
    twitchUrl,
    fetchYouTube,
    buildYouTubeCard,
    youtubeUrl,
  });
  if (LINK_ARCHIVE_CHANNEL_IDS.length > 0) await setUpArchiveChannels();
  else console.log('LINK_ARCHIVE_CHANNEL_IDS not set - link archiving is off.');
  await closeOldReplyThreads();
  setInterval(() => closeOldReplyThreads().catch((err) => console.error('Reply thread cleanup failed:', err)), REPLY_THREAD_CHECK_MS);
});

// Reactions on role panels give and take roles.
for (const [event, added] of [
  [Events.MessageReactionAdd, true],
  [Events.MessageReactionRemove, false],
]) {
  client.on(event, (reaction, user) => {
    const { guildId, channel, channelId } = reaction.message;
    if (!isAllowedServer(guildId) || !access.isEnabled(guildId, 'roles') || access.isIgnoredChannel(guildId, channel, channelId)) return;
    roles.handleReaction(reaction, user, added).catch((err) => console.error('Role panel reaction failed:', err));
  });
}

// The music player leaves when everyone else does; Join to Create makes and
// removes voice channels.
client.on(Events.VoiceStateUpdate, (before, after) => {
  if (!isAllowedServer(after.guild.id)) return;
  try {
    music.voiceStateChanged(before, after);
  } catch (err) {
    console.error('Music voice update failed:', err);
  }
  tempVoice.voiceStateChanged(before, after).catch((err) => console.error('Join to Create voice update failed:', err));
});

client.on(Events.ChannelDelete, (channel) => tempVoice.channelDeleted(channel));

// A deleted role panel message takes its panel with it; deletions and edits
// go in the mod log.
client.on(Events.MessageDelete, (message) => {
  roles.forgetDeletedPanel(message.id);
  if (isAllowedServer(message.guildId)) logs.messageDeleted(message)?.catch((err) => console.error('Mod log (delete) failed:', err));
});
client.on(Events.MessageUpdate, (before, after) => {
  if (isAllowedServer(after.guildId)) logs.messageEdited(before, after)?.catch((err) => console.error('Mod log (edit) failed:', err));
});
for (const [event, report] of [
  [Events.GuildBanAdd, logs.memberBanned],
  [Events.GuildBanRemove, logs.memberUnbanned],
  // These only fire with the Server Members intent (see enableMemberEvents).
  [Events.GuildMemberAdd, logs.memberJoined],
  [Events.GuildMemberRemove, logs.memberLeft],
  [Events.GuildMemberAdd, welcome.memberJoined],
  [Events.GuildMemberRemove, welcome.memberLeft],
]) {
  client.on(event, (subject) => {
    if (isAllowedServer(subject.guild.id)) report(subject).catch((err) => console.error(`${report.name} failed:`, err));
  });
}

// The Server Members intent is "privileged": Discord refuses to log in with it
// unless it's switched on in the Developer Portal (Bot → Server Members
// Intent). So it's only asked for when the app's settings say it's on.
async function enableMemberEvents() {
  const GATEWAY_GUILD_MEMBERS = 1 << 14;
  const GATEWAY_GUILD_MEMBERS_LIMITED = 1 << 15;
  const res = await request('https://discord.com/api/v10/applications/@me', {
    headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` },
  }).catch(() => null);
  const flags = (await res?.json().catch(() => null))?.flags ?? 0;
  if (flags & (GATEWAY_GUILD_MEMBERS | GATEWAY_GUILD_MEMBERS_LIMITED)) {
    // The intents are frozen, but replacing them before login works - they're read when connecting.
    client.options.intents = new IntentsBitField(client.options.intents.bitfield | GatewayIntentBits.GuildMembers).freeze();
    console.log('Server Members intent is on - member joins and leaves are tracked.');
  } else {
    console.log(
      'Server Members intent is off in the Developer Portal - joins and leaves (mod log, welcome messages) are skipped until it is turned on.'
    );
  }
}

// Added to a server that isn't on ALLOWED_GUILD_IDS: leave it straight away.
client.on(Events.GuildCreate, async (guild) => {
  if (!isAllowedServer(guild.id)) await leaveServer(guild);
});

// At startup, leaves any server not on ALLOWED_GUILD_IDS (e.g. one the bot was
// added to while it was off). If NONE of its servers are on the list, the list
// is almost certainly mistyped, and leaving them all couldn't be undone without
// re-inviting the bot - so it stays, ignoring them, and says so.
async function leaveUnlistedServers() {
  if (ALLOWED_GUILD_IDS.size === 0) {
    console.log('ALLOWED_GUILD_IDS not set - the bot works in any server it is added to.');
    return;
  }
  const unlisted = client.guilds.cache.filter((guild) => !ALLOWED_GUILD_IDS.has(guild.id));
  if (unlisted.size > 0 && unlisted.size === client.guilds.cache.size) {
    console.error(
      "None of the bot's servers are on ALLOWED_GUILD_IDS - check it in .env. Not leaving any; " +
        'the bot ignores them until the list is fixed.'
    );
    return;
  }
  for (const guild of unlisted.values()) await leaveServer(guild);
}

async function leaveServer(guild) {
  try {
    await guild.leave();
    console.log(`Left "${guild.name}" (${guild.id}) - it isn't on ALLOWED_GUILD_IDS.`);
  } catch (err) {
    console.error(`Couldn't leave "${guild.name}" (${guild.id}), which isn't on ALLOWED_GUILD_IDS:`, err.message);
  }
}

// Without an 'error' listener, a client error event would crash the process.
client.on(Events.Error, (err) => console.error('Discord client error:', err));

// Last-resort safety net so one unexpected failure can't take the whole bot down.
process.on('unhandledRejection', (err) => console.error('Unhandled promise rejection:', err));

async function start() {
  // Two copies would each repost and delete every link (see instance.js).
  if (isMainProgram) {
    const lock = await takeLock().catch((err) => {
      console.error("Couldn't check for another running copy of the bot:", err.message);
      return { ok: true };
    });
    if (!lock.ok) {
      const which = lock.runningPid ? ` (process ${lock.runningPid})` : '';
      console.error(`The bot is already running on this PC${which}. Stop it with "npm run stop", then start it again.`);
      process.exit(1);
    }
  }
  try {
    if (isMainProgram) await enableMemberEvents();
    await client.login(process.env.DISCORD_TOKEN);
  } catch (err) {
    console.error('Failed to log in to Discord - check DISCORD_TOKEN in .env:', err.message);
    process.exit(1);
  }
}

start();
