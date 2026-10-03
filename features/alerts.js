// Twitch go-live and YouTube new-upload alerts. Admins add them with /alerts;
// the bot checks Twitch every 2 minutes and YouTube every 10, and posts a card
// (the same Twitch and YouTube cards links get) when someone goes live or
// uploads. Saved in data/alerts.json.
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextDisplayBuilder,
  escapeMarkdown,
} = require('discord.js');
const { createStore } = require('../store');
const access = require('./access');

const store = createStore('alerts.json', { alerts: [] });

const TWITCH_CHECK_MS = 2 * 60 * 1000;
const YOUTUBE_CHECK_MS = 10 * 60 * 1000;
const MAX_ALERTS_PER_SERVER = 25;
// Videos older than this are never announced, even if the feed suddenly lists
// them as new (feeds sometimes reshuffle).
const MAX_VIDEO_AGE_MS = 24 * 60 * 60 * 1000;
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const DEFAULT_MESSAGES = {
  twitch: '🔴 **{name}** is live!',
  youtube: '▶️ **{name}** posted a new video: **{title}**',
};

const ALERTS_COMMAND = new SlashCommandBuilder()
  .setName('alerts')
  .setDescription('Twitch go-live and YouTube upload alerts')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) =>
    addCommonOptions(
      sub
        .setName('twitch')
        .setDescription('Post when a Twitch streamer goes live')
        .addStringOption((o) => o.setName('streamer').setDescription('Their Twitch name or channel link').setRequired(true))
    )
  )
  .addSubcommand((sub) =>
    addCommonOptions(
      sub
        .setName('youtube')
        .setDescription('Post when a YouTube channel uploads')
        .addStringOption((o) =>
          o.setName('channel').setDescription('Their channel link, @handle, or channel ID').setRequired(true)
        )
    )
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Stop an alert')
      .addIntegerOption((o) => o.setName('number').setDescription('Its number from /alerts list').setRequired(true).setMinValue(1))
  )
  .addSubcommand((sub) => sub.setName('list').setDescription("List this server's alerts"));

function addCommonOptions(sub) {
  return sub
    .addChannelOption((o) =>
      o
        .setName('post-in')
        .setDescription('The channel alerts are posted in')
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    )
    .addRoleOption((o) => o.setName('ping').setDescription('A role to ping with each alert'))
    .addStringOption((o) =>
      o.setName('message').setDescription('Custom text - {name} is the streamer or channel, {title} the stream or video').setMaxLength(300)
    );
}

// The functions that fetch and draw Twitch and YouTube cards live in index.js;
// it hands them over with init().
let deps = null;

function init(dependencies) {
  deps = dependencies;
  setInterval(() => checkTwitch().catch((err) => console.error('Twitch alert check failed:', err)), TWITCH_CHECK_MS);
  setInterval(() => checkYouTube().catch((err) => console.error('YouTube alert check failed:', err)), YOUTUBE_CHECK_MS);
}

function alerts() {
  return store.load().alerts;
}

function reply(interaction, content) {
  const payload = { content, allowedMentions: { parse: [] } };
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

// ---------------------------------------------------------------------------
// Looking up Twitch streamers and YouTube channels
// ---------------------------------------------------------------------------

// "https://twitch.tv/Name", "twitch.tv/name/videos" or "name" -> "name".
function twitchLoginFrom(text) {
  const login = text.trim().replace(/^https?:\/\/(?:www\.|m\.)?twitch\.tv\//i, '').split(/[/?#]/)[0].toLowerCase();
  return /^\w{3,25}$/.test(login) ? login : null;
}

// A channel link, @handle, or channel id -> { id: 'UC...', name }.
async function findYouTubeChannel(text) {
  const input = text.trim();
  const directId = input.match(/(?:^|\/channel\/)(UC[\w-]{22})(?:[/?#]|$)/)?.[1];
  if (directId) {
    const feed = await fetchFeed(directId);
    return { id: directId, name: feed.channelName ?? directId };
  }
  const handle = input.match(/(?:youtube\.com\/)?(@[\w.-]{3,30})/)?.[1];
  if (!handle) return null;
  const res = await deps.request(`https://www.youtube.com/${handle}`, {
    headers: { 'User-Agent': BROWSER_USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' },
  });
  if (!res.ok) return null;
  const page = await res.text();
  const id =
    page.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/)?.[1] ??
    page.match(/"externalId":"(UC[\w-]{22})"/)?.[1];
  const name = page.match(/<meta property="og:title" content="([^"]+)"/)?.[1];
  return id ? { id, name: deps.decodeHtmlEntities(name ?? handle) } : null;
}

// YouTube's official per-channel feed of its 15 newest uploads, newest first.
async function fetchFeed(channelId) {
  const res = await deps.request(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
  if (!res.ok) throw new Error(`YouTube feed HTTP ${res.status}`);
  const xml = await res.text();
  const channelName = xml.match(/<author>\s*<name>([^<]+)<\/name>/)?.[1];
  const videos = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, entry]) => ({
    id: entry.match(/<yt:videoId>([\w-]{11})<\/yt:videoId>/)?.[1],
    title: deps.decodeHtmlEntities(entry.match(/<title>([^<]*)<\/title>/)?.[1] ?? ''),
    short: /<link rel="alternate" href="https:\/\/www\.youtube\.com\/shorts\//.test(entry),
    published: Date.parse(entry.match(/<published>([^<]+)<\/published>/)?.[1] ?? ''),
  }));
  return { channelName: channelName && deps.decodeHtmlEntities(channelName), videos: videos.filter((v) => v.id) };
}

// ---------------------------------------------------------------------------
// /alerts
// ---------------------------------------------------------------------------

async function handleCommand(interaction) {
  if (interaction.commandName !== ALERTS_COMMAND.name) return false;
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await reply(interaction, 'Only people with the **Manage Server** permission can use /alerts.');
    return true;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const sub = interaction.options.getSubcommand();
  if (sub === 'twitch' || sub === 'youtube') await addAlert(interaction, sub);
  else if (sub === 'remove') await removeAlert(interaction);
  else if (sub === 'list') await listAlerts(interaction);
  return true;
}

async function addAlert(interaction, platform) {
  const mine = alerts().filter((alert) => alert.guildId === interaction.guildId);
  const postIn = interaction.options.getChannel('post-in', true);
  const channel = interaction.guild.channels.cache.get(postIn.id) ?? postIn;
  const canPost = channel.permissionsFor?.(interaction.guild.members.me)?.has([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
  ]);
  if (!canPost) return reply(interaction, `I can't post in <#${postIn.id}> - give me View Channel and Send Messages there.`);
  const role = interaction.options.getRole('ping');
  if (role?.id === interaction.guildId) return reply(interaction, 'To ping everyone, put @everyone in the **message** instead.');

  const alert = {
    guildId: interaction.guildId,
    platform,
    channelId: postIn.id,
    roleId: role?.id ?? null,
    message: interaction.options.getString('message') ?? null,
    state: {},
  };
  if (platform === 'twitch') {
    const login = twitchLoginFrom(interaction.options.getString('streamer', true));
    const user = login && (await deps.fetchTwitch('channel', login).catch(() => null));
    if (!user) return reply(interaction, "I can't find that Twitch streamer - use their Twitch name, like `shroud`.");
    Object.assign(alert, { target: user.login, name: user.displayName || user.login });
    // Already live? That stream isn't announced - the next one is.
    alert.state.liveSince = user.stream?.createdAt ?? null;
  } else {
    const found = await findYouTubeChannel(interaction.options.getString('channel', true)).catch(() => null);
    if (!found) return reply(interaction, "I can't find that YouTube channel - use its link, like `https://www.youtube.com/@name`.");
    const feed = await fetchFeed(found.id).catch(() => ({ videos: [] }));
    Object.assign(alert, { target: found.id, name: found.name });
    // Everything already uploaded counts as seen, so only new videos are posted.
    alert.state.seen = feed.videos.map((video) => video.id);
  }

  const existing = mine.find((a) => a.platform === platform && a.target === alert.target && a.channelId === alert.channelId);
  if (existing) Object.assign(existing, { roleId: alert.roleId, message: alert.message });
  else if (mine.length >= MAX_ALERTS_PER_SERVER) return reply(interaction, `A server can have at most ${MAX_ALERTS_PER_SERVER} alerts.`);
  else alerts().push(alert);
  store.save();
  console.log(`/alerts: ${interaction.user.tag} (${interaction.user.id}) ${existing ? 'updated' : 'added'} a ${platform} alert for ${alert.target} in channel ${alert.channelId}.`);
  const when = platform === 'twitch' ? `goes live${alert.state.liveSince ? " (they're live now - the next stream gets the first alert)" : ''}` : 'uploads';
  return reply(interaction, `${existing ? 'Updated' : 'Added'}: I'll post in <#${postIn.id}> when **${escapeMarkdown(alert.name)}** ${when}.`);
}

function listed(interaction) {
  return alerts().filter((alert) => alert.guildId === interaction.guildId);
}

async function removeAlert(interaction) {
  const alert = listed(interaction)[interaction.options.getInteger('number', true) - 1];
  if (!alert) return reply(interaction, "There's no alert with that number - see `/alerts list`.");
  store.load().alerts = alerts().filter((a) => a !== alert);
  store.save();
  console.log(`/alerts: ${interaction.user.tag} (${interaction.user.id}) removed the ${alert.platform} alert for ${alert.target}.`);
  return reply(interaction, `Stopped the ${alert.platform === 'twitch' ? 'Twitch' : 'YouTube'} alert for **${escapeMarkdown(alert.name)}**.`);
}

async function listAlerts(interaction) {
  const mine = listed(interaction);
  if (mine.length === 0) return reply(interaction, 'No alerts yet - add one with `/alerts twitch` or `/alerts youtube`.');
  const lines = mine.map(
    (alert, i) =>
      `**${i + 1}.** ${alert.platform === 'twitch' ? '🔴 Twitch' : '▶️ YouTube'} - **${escapeMarkdown(alert.name)}** → <#${alert.channelId}>` +
      (alert.roleId ? ` (pings <@&${alert.roleId}>)` : '')
  );
  return reply(interaction, lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Checking and posting
// ---------------------------------------------------------------------------

function alertText(alert, title) {
  const template = alert.message ?? DEFAULT_MESSAGES[alert.platform];
  const text = template.replaceAll('{name}', escapeMarkdown(alert.name)).replaceAll('{title}', escapeMarkdown(title ?? ''));
  return alert.roleId ? `${text}\n<@&${alert.roleId}>` : text;
}

async function post(alert, components) {
  if (!deps.isAllowedServer(alert.guildId) || !access.isEnabled(alert.guildId, 'alerts')) return;
  const channel = await deps.client.channels.fetch(alert.channelId).catch(() => null);
  if (!channel) {
    console.error(`Alert for ${alert.target}: its channel ${alert.channelId} is gone.`);
    return;
  }
  await channel.send({
    flags: MessageFlags.IsComponentsV2,
    components,
    // Only the alert's own role (or an @everyone typed into its message) pings.
    allowedMentions: { roles: alert.roleId ? [alert.roleId] : [], parse: /@everyone|@here/.test(alert.message ?? '') ? ['everyone'] : [] },
  });
}

async function checkTwitch() {
  const twitchAlerts = alerts().filter((alert) => alert.platform === 'twitch');
  const byLogin = new Map();
  for (const alert of twitchAlerts) {
    if (!byLogin.has(alert.target)) byLogin.set(alert.target, await deps.fetchTwitch('channel', alert.target).catch(() => null));
  }
  let changed = false;
  for (const alert of twitchAlerts) {
    const user = byLogin.get(alert.target);
    const startedAt = user?.stream?.createdAt;
    if (!startedAt || startedAt === alert.state.liveSince) continue;
    alert.state.liveSince = startedAt;
    changed = true;
    const url = deps.twitchUrl('channel', alert.target);
    await post(alert, [
      new TextDisplayBuilder().setContent(alertText(alert, user.stream.title)),
      deps.buildTwitchCard('channel', user, url),
      new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Watch on Twitch').setURL(url)),
    ]).catch((err) => console.error(`Couldn't post the Twitch alert for ${alert.target}:`, err.message));
  }
  if (changed) store.save();
}

async function checkYouTube() {
  const youtubeAlerts = alerts().filter((alert) => alert.platform === 'youtube');
  const feeds = new Map();
  for (const alert of youtubeAlerts) {
    if (!feeds.has(alert.target)) feeds.set(alert.target, await fetchFeed(alert.target).catch(() => null));
  }
  let changed = false;
  for (const alert of youtubeAlerts) {
    const feed = feeds.get(alert.target);
    if (!feed) continue;
    const seen = new Set(alert.state.seen ?? []);
    const fresh = feed.videos.filter((video) => !seen.has(video.id));
    if (fresh.length === 0) continue;
    alert.state.seen = feed.videos.map((video) => video.id);
    changed = true;
    // Oldest first, and never anything old enough to be a reshuffle.
    for (const video of fresh.reverse()) {
      if (!(Date.now() - video.published < MAX_VIDEO_AGE_MS)) continue;
      const link = { kind: video.short ? 'short' : 'video', id: video.id, time: null, url: deps.youtubeUrl(video.short ? 'short' : 'video', video.id) };
      const details = await deps.fetchYouTube(video.id).catch(() => null);
      await post(alert, [
        new TextDisplayBuilder().setContent(alertText(alert, details?.title ?? video.title)),
        ...(details ? [deps.buildYouTubeCard(details, link)] : []),
        ...(details ? [] : [new TextDisplayBuilder().setContent(link.url)]),
      ]).catch((err) => console.error(`Couldn't post the YouTube alert for ${alert.target}:`, err.message));
    }
  }
  if (changed) store.save();
}

module.exports = {
  commands: [ALERTS_COMMAND],
  handleCommand,
  init,
  // For /setup and /access: a server's alerts.
  alertsIn: (guildId) => alerts().filter((alert) => alert.guildId === guildId),
  // For tests.
  checkTwitch,
  checkYouTube,
  twitchLoginFrom,
  setDependencies: (dependencies) => {
    deps = dependencies;
  },
};
