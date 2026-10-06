// Who can use what, and where. Admins change it with /access or /setup:
// - turn whole features on or off
// - let only some roles, or only some channels, use a feature or one command
// - make Spork ignore a channel completely
// Admins (Manage Server) skip role limits so they can't lock themselves out,
// and /help, /setup and /access always work. Saved in data/access.json.
const { PermissionFlagsBits } = require('discord.js');
const { createStore } = require('../store');

const store = createStore('access.json', { guilds: {} });

// Every feature, in the order /help and /setup show them. `settings` is the
// feature's own settings command, which still works while it's turned off.
const FEATURES = [
  { key: 'links', emoji: '🔗', name: 'Link cards', short: 'Turns X, TikTok, Instagram, Twitch, YouTube and news links into nice cards', commands: ['embeds'], settings: 'embeds' },
  { key: 'roles', emoji: '🎭', name: 'Role panels', short: 'Buttons, menus or reactions people use to pick their own roles', commands: ['roles'] },
  { key: 'expressions', emoji: '😀', name: 'Emojis & sounds', short: 'Add emojis and soundboard sounds to the server', commands: ['emoji', 'sound'] },
  { key: 'alerts', emoji: '🔴', name: 'Live & video alerts', short: 'Tells everyone when a Twitch streamer goes live or a YouTube video comes out', commands: ['alerts'] },
  { key: 'moderation', emoji: '🛡️', name: 'Moderation', short: 'Warn, time out, kick, ban, and clean up messages', commands: ['mod'] },
  { key: 'automod', emoji: '🤖', name: 'Auto-mod', short: 'Blocks bad words, spam and invite links by itself', commands: ['automod'] },
  { key: 'logs', emoji: '📋', name: 'Mod log', short: 'Writes down deleted messages, edits, bans, joins and leaves', commands: ['logs'] },
  { key: 'welcome', emoji: '👋', name: 'Welcome messages', short: 'Says hi to new members and goodbye when they leave', commands: ['welcome'] },
  { key: 'leveling', emoji: '⭐', name: 'Levels', short: 'Members earn XP for chatting and level up', commands: ['rank', 'leaderboard', 'levels'], settings: 'levels', startsOff: true },
  { key: 'music', emoji: '🎵', name: 'Music', short: 'Plays songs, radio and clips in voice channels', commands: ['play', 'radio', 'music', 'music-setup'], settings: 'music-setup' },
  { key: 'tempvoice', emoji: '➕', name: 'Join to Create', short: 'Join one voice channel to get your own voice channel, gone when everyone leaves', commands: ['join-to-create'], settings: 'join-to-create' },
];
const ALWAYS_ALLOWED = new Set(['help', 'setup', 'access', 'restart']);
const featureByKey = new Map(FEATURES.map((feature) => [feature.key, feature]));
const featureOfCommand = new Map(FEATURES.flatMap((feature) => feature.commands.map((command) => [command, feature])));

function guildData(guildId) {
  const guilds = store.load().guilds;
  guilds[guildId] ??= { features: {}, ignored: [], rules: {} };
  return guilds[guildId];
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function isEnabled(guildId, key) {
  const saved = store.load().guilds[guildId]?.features?.[key];
  return saved ?? !featureByKey.get(key)?.startsOff;
}

function setEnabled(guildId, key, on) {
  guildData(guildId).features[key] = Boolean(on);
  store.save();
}

const ignoredChannels = (guildId) => store.load().guilds[guildId]?.ignored ?? [];

function setIgnored(guildId, channelIds) {
  guildData(guildId).ignored = [...new Set(channelIds)];
  store.save();
}

// A rule's target: 'all' (every command), 'feature:music', or 'command:play'.
function ruleFor(guildId, target) {
  const rule = store.load().guilds[guildId]?.rules?.[target];
  return { channels: rule?.channels ?? [], roles: rule?.roles ?? [] };
}

function setRule(guildId, target, { channels, roles }) {
  const rules = guildData(guildId).rules;
  const next = { ...ruleFor(guildId, target), ...(channels && { channels: [...new Set(channels)] }), ...(roles && { roles: [...new Set(roles)] }) };
  if (next.channels.length || next.roles.length) rules[target] = next;
  else delete rules[target];
  store.save();
}

function resetRule(guildId, target) {
  delete guildData(guildId).rules[target];
  store.save();
}

function allRules(guildId) {
  return Object.entries(store.load().guilds[guildId]?.rules ?? {});
}

// "feature:music" -> "🎵 Music", "command:play" -> "/play", "all" -> "all of Spork"
function targetLabel(target) {
  if (target === 'all') return 'all of Spork';
  const [kind, name] = target.split(':');
  if (kind === 'feature') {
    const feature = featureByKey.get(name);
    return feature ? `${feature.emoji} ${feature.name}` : name;
  }
  return `/${name}`;
}

// What an admin typed or picked -> a target, or null.
function parseTarget(text) {
  const value = (text ?? '').trim().toLowerCase().replace(/^\//, '');
  if (!value) return null;
  if (value === 'all' || value === 'everything') return 'all';
  if (value.startsWith('feature:') && featureByKey.has(value.slice(8))) return value;
  if (value.startsWith('command:') && featureOfCommand.has(value.slice(8))) return value;
  if (featureByKey.has(value)) return `feature:${value}`;
  if (featureOfCommand.has(value)) return `command:${value}`;
  const byName = FEATURES.find((feature) => feature.name.toLowerCase() === value);
  return byName ? `feature:${byName.key}` : null;
}

// Every target, for autocomplete: [{ name, value }]
function targetChoices() {
  return [
    { name: '🌐 Everything (all of Spork)', value: 'all' },
    ...FEATURES.flatMap((feature) => [
      { name: `${feature.emoji} ${feature.name} (all of its commands)`, value: `feature:${feature.key}` },
      ...feature.commands.map((command) => ({ name: `   /${command}`, value: `command:${command}` })),
    ]),
  ];
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const mentionChannels = (ids) => ids.map((id) => `<#${id}>`).join(', ');
const mentionRoles = (ids) => ids.map((id) => `<@&${id}>`).join(', ');

function roleIdsOf(member) {
  if (!member) return [];
  if (Array.isArray(member.roles)) return member.roles;
  return [...(member.roles?.cache?.keys?.() ?? [])];
}

// Threads follow their channel.
function placeOf(channel, channelId) {
  return { channelId: channelId ?? channel?.id, parentId: channel?.isThread?.() ? channel.parentId : null };
}

// Why something can't be used here, in plain words - or null when it can.
// `isAdmin` skips role limits (never channel limits or switched-off features).
function problem({ guildId, channelId, parentId, roleIds = [], isAdmin = false, feature, command }) {
  if (!guildId) return null;
  const here = (list) => list.includes(channelId) || (parentId && list.includes(parentId));
  if (here(ignoredChannels(guildId))) return "I'm switched off in this channel. Try another channel.";
  const featureInfo = featureByKey.get(feature);
  if (featureInfo && !isEnabled(guildId, feature) && command !== featureInfo.settings) {
    return `**${featureInfo.emoji} ${featureInfo.name}** is turned off in this server. An admin can turn it on with \`/setup\` or \`/access feature\`.`;
  }
  for (const target of ['all', feature && `feature:${feature}`, command && `command:${command}`].filter(Boolean)) {
    const rule = ruleFor(guildId, target);
    const what = target === 'all' ? 'my commands' : target.startsWith('command:') ? `/${command}` : `**${featureInfo.emoji} ${featureInfo.name}**`;
    if (rule.channels.length && !here(rule.channels)) return `You can use ${what} in ${mentionChannels(rule.channels)}.`;
    if (rule.roles.length && !isAdmin && !rule.roles.some((id) => roleIds.includes(id))) return `Only ${mentionRoles(rule.roles)} can use ${what}.`;
  }
  return null;
}

const isAdmin = (permissions) => Boolean(permissions?.has?.(PermissionFlagsBits.ManageGuild));

// For slash commands.
function commandProblem(interaction) {
  const command = interaction.commandName;
  if (!interaction.guildId || ALWAYS_ALLOWED.has(command)) return null;
  return problem({
    guildId: interaction.guildId,
    ...placeOf(interaction.channel, interaction.channelId),
    roleIds: roleIdsOf(interaction.member),
    isAdmin: isAdmin(interaction.memberPermissions),
    feature: featureOfCommand.get(command)?.key,
    command,
  });
}

// For buttons and menus that belong to a feature (role panels, the music card).
function componentProblem(interaction, feature) {
  if (!interaction.guildId) return null;
  return problem({
    guildId: interaction.guildId,
    ...placeOf(interaction.channel, interaction.channelId),
    roleIds: roleIdsOf(interaction.member),
    isAdmin: isAdmin(interaction.memberPermissions),
    feature,
  });
}

// For things that happen when someone chats (link cards, XP): limits are
// filters here, so they count for admins too.
function allowsMessage(message, feature) {
  if (!message.guildId) return true;
  return !problem({ guildId: message.guildId, ...placeOf(message.channel, message.channelId), roleIds: roleIdsOf(message.member), feature });
}

function isIgnoredChannel(guildId, channel, channelId) {
  const { channelId: id, parentId } = placeOf(channel, channelId);
  const ignored = ignoredChannels(guildId);
  return ignored.includes(id) || Boolean(parentId && ignored.includes(parentId));
}

module.exports = {
  FEATURES,
  ALWAYS_ALLOWED,
  featureByKey,
  featureOfCommand,
  isEnabled,
  setEnabled,
  ignoredChannels,
  setIgnored,
  ruleFor,
  setRule,
  resetRule,
  allRules,
  targetLabel,
  parseTarget,
  targetChoices,
  problem,
  commandProblem,
  componentProblem,
  allowsMessage,
  isIgnoredChannel,
  mentionChannels,
  mentionRoles,
};
