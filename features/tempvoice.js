// Join to Create: join a special voice channel (a "hub") and Spork makes you
// your own voice channel next to it and moves you in. It's deleted when
// everyone leaves. The owner gets Manage Channels on it (rename it or set a
// member limit with Discord's own Edit Channel) and buttons in its chat to
// lock it, unlock it, or let someone else claim it once they've left.
// Admins set hubs up with /join-to-create. Saved in data/tempvoice.json.
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ContainerBuilder,
  InteractionContextType,
  MessageFlags,
  OverwriteType,
  PermissionFlagsBits,
  PermissionsBitField,
  SlashCommandBuilder,
  TextDisplayBuilder,
} = require('discord.js');
const { createStore } = require('../store');
const access = require('./access');

const store = createStore('tempvoice.json', { guilds: {} });

const ROOM_COLOR = 0x5865f2;
const HUB_NAME = '➕ Join to Create';
const DEFAULT_NAME = "🔊 {name}'s channel";
// Joining a hub again this soon after making a channel does nothing, so
// hopping in and out can't flood the server with channels.
const COOLDOWN_MS = 5_000;
// What Spork needs to make channels, move people into them, and lock them.
const BOT_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers, PermissionFlagsBits.ManageRoles];
// The owner can rename the channel, set a limit, and move or disconnect people in it.
const OWNER_ALLOW = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect | PermissionFlagsBits.Speak | PermissionFlagsBits.ManageChannels | PermissionFlagsBits.MoveMembers;
// Spork itself always gets in (to move people, to play music, to clean up).
const BOT_ALLOW = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect | PermissionFlagsBits.Speak | PermissionFlagsBits.ManageChannels | PermissionFlagsBits.MoveMembers;

const nameOption = (o) => o.setName('name').setDescription("Name for the channels it makes - {name} is the member's name").setMaxLength(90);
const limitOption = (o) => o.setName('limit').setDescription('How many people fit in each one (0: no limit)').setMinValue(0).setMaxValue(99);

const COMMAND = new SlashCommandBuilder()
  .setName('join-to-create')
  .setDescription('Voice channels that make a new voice channel for whoever joins them')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) =>
    s
      .setName('create')
      .setDescription('Make a brand-new Join to Create voice channel')
      .addChannelOption((o) => o.setName('category').setDescription('Which category to put it in').addChannelTypes(ChannelType.GuildCategory))
      .addStringOption(nameOption)
      .addIntegerOption(limitOption)
  )
  .addSubcommand((s) =>
    s
      .setName('add')
      .setDescription('Turn one of your voice channels into a Join to Create channel (or change one)')
      .addChannelOption((o) => o.setName('channel').setDescription('The voice channel').setRequired(true).addChannelTypes(ChannelType.GuildVoice))
      .addStringOption(nameOption)
      .addIntegerOption(limitOption)
  )
  .addSubcommand((s) =>
    s
      .setName('remove')
      .setDescription("Stop a channel from making voice channels (I don't delete it)")
      .addChannelOption((o) => o.setName('channel').setDescription('The Join to Create channel').setRequired(true).addChannelTypes(ChannelType.GuildVoice))
  )
  .addSubcommand((s) => s.setName('status').setDescription('See the Join to Create channels, and the channels they made'));

function guildData(guildId) {
  const guilds = store.load().guilds;
  guilds[guildId] ??= { hubs: {}, rooms: {} };
  return guilds[guildId];
}

// The Join to Create channel that made this channel, if any (music uses it).
const hubOf = (guildId, channelId) => store.load().guilds[guildId]?.rooms[channelId]?.hubId ?? null;

const roomName = (template, member) => template.replaceAll('{name}', member.displayName ?? member.user?.username ?? 'Someone').slice(0, 100);

const humansIn = (channel) => channel.members.filter((member) => !member.user?.bot).size;

function missingPermissions(guild) {
  const me = guild.members.me;
  const missing = BOT_PERMISSIONS.filter((permission) => !me?.permissions?.has?.(permission));
  return new PermissionsBitField(missing).toArray().map((name) => name.replace(/([a-z])([A-Z])/g, '$1 $2'));
}

// The category's permissions (like a synced channel), the owner's and
// Spork's own. Locked: every role loses Connect, so only the owner and the
// people inside right now can get in.
function roomOverwrites(guild, parent, ownerId, { locked = false, insideIds = [] } = {}) {
  const botId = guild.members.me?.id;
  const overwrites = [...(parent?.permissionOverwrites.cache.values() ?? [])]
    .filter((o) => o.id !== ownerId && o.id !== botId)
    .map((o) => ({ id: o.id, type: o.type, allow: o.allow.bitfield, deny: o.deny.bitfield }));
  if (locked) {
    const connect = PermissionFlagsBits.Connect;
    if (!overwrites.some((o) => o.id === guild.id)) overwrites.push({ id: guild.id, type: OverwriteType.Role, allow: 0n, deny: 0n });
    for (const o of overwrites) {
      if (o.type !== OverwriteType.Role) continue;
      o.allow &= ~connect;
      o.deny |= connect;
    }
    for (const id of insideIds) {
      if (id === ownerId || id === botId) continue;
      const own = overwrites.find((o) => o.id === id);
      if (own) {
        own.allow |= connect;
        own.deny &= ~connect;
      } else overwrites.push({ id, type: OverwriteType.Member, allow: connect, deny: 0n });
    }
  }
  overwrites.push({ id: ownerId, type: OverwriteType.Member, allow: OWNER_ALLOW, deny: 0n });
  if (botId) overwrites.push({ id: botId, type: OverwriteType.Member, allow: BOT_ALLOW, deny: 0n });
  return overwrites;
}

// The card in a new channel's chat.
function controlPanel(ownerId, guildId) {
  const lines = [
    '### 🔊 Your own voice channel',
    `<@${ownerId}>, this channel is all yours! It goes away when everyone leaves.`,
    '-# ✏️ Rename it or set a member limit: right-click the channel (or press and hold it on your phone) → **Edit Channel**.',
    '-# 🔒 **Lock** it so nobody new can join, 🔓 **Unlock** it again, or 👑 **Claim** it if the owner left.',
  ];
  if (access.isEnabled(guildId, 'music')) lines.push('-# 🎵 Want music? Use `/play` right here in this chat.');
  const button = (action, label, emoji) => new ButtonBuilder().setCustomId(`vc:${action}`).setLabel(label).setEmoji(emoji).setStyle(ButtonStyle.Secondary);
  const container = new ContainerBuilder()
    .setAccentColor(ROOM_COLOR)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))
    .addActionRowComponents(new ActionRowBuilder().addComponents(button('lock', 'Lock', '🔒'), button('unlock', 'Unlock', '🔓'), button('claim', 'Claim', '👑')));
  return { flags: MessageFlags.IsComponentsV2, components: [container], allowedMentions: { parse: [] } };
}

// ---------------------------------------------------------------------------
// Making and removing channels
// ---------------------------------------------------------------------------

const making = new Set();
const lastMade = new Map();

async function makeRoom(member, hub, settings, now = Date.now()) {
  const { guild } = member;
  const data = guildData(guild.id);
  const key = `${guild.id}:${member.id}`;
  // They already have one: back in they go.
  const ownRoom = Object.keys(data.rooms).find((id) => data.rooms[id].ownerId === member.id && guild.channels.cache.has(id));
  if (ownRoom) return member.voice.setChannel(ownRoom, 'Join to Create: back to their channel').catch(() => {});
  if (making.has(key) || now - (lastMade.get(key) ?? 0) < COOLDOWN_MS) return;
  const missing = missingPermissions(guild);
  if (missing.length) return console.error(`Join to Create in "${guild.name}": I need ${missing.join(', ')} to make voice channels.`);
  making.add(key);
  try {
    const room = await guild.channels.create({
      name: roomName(settings.name, member),
      type: ChannelType.GuildVoice,
      parent: hub.parentId ?? undefined,
      bitrate: hub.bitrate,
      userLimit: settings.limit ?? 0,
      permissionOverwrites: roomOverwrites(guild, hub.parent, member.id),
      reason: `Join to Create: ${member.user?.tag ?? member.id}`,
    });
    data.rooms[room.id] = { ownerId: member.id, hubId: hub.id, locked: false };
    store.save();
    lastMade.set(key, now);
    console.log(`Join to Create: made channel ${room.id} for ${member.id} in "${guild.name}".`);
    try {
      await member.voice.setChannel(room, 'Join to Create');
    } catch {
      // They left the hub before they could be moved.
      return removeRoom(guild, room.id, 'Join to Create: the member left before moving in');
    }
    await room.send(controlPanel(member.id, guild.id)).catch((err) => console.error('Join to Create: the channel card failed:', err.message));
  } catch (err) {
    console.error(`Join to Create in "${guild.name}": couldn't make a channel:`, err.message);
  } finally {
    making.delete(key);
  }
}

async function removeRoom(guild, channelId, reason) {
  const data = guildData(guild.id);
  delete data.rooms[channelId];
  store.save();
  await guild.channels.cache
    .get(channelId)
    ?.delete(reason)
    .catch((err) => console.error(`Join to Create in "${guild.name}": couldn't delete channel ${channelId}:`, err.message));
}

// index.js forwards every voice change here.
async function voiceStateChanged(before, after) {
  const { guild } = after;
  const data = store.load().guilds[guild.id];
  if (!data || before.channelId === after.channelId) return;
  // The last person left a channel made here: delete it.
  if (before.channelId && data.rooms[before.channelId]) {
    const channel = guild.channels.cache.get(before.channelId);
    if (!channel) {
      delete data.rooms[before.channelId];
      store.save();
    } else if (humansIn(channel) === 0) await removeRoom(guild, before.channelId, 'Join to Create: everyone left');
  }
  const settings = after.channelId && data.hubs[after.channelId];
  if (settings && after.member && !after.member.user?.bot && after.channel && access.isEnabled(guild.id, 'tempvoice')) {
    await makeRoom(after.member, after.channel, settings);
  }
}

// A deleted hub or channel is forgotten.
function channelDeleted(channel) {
  const data = channel.guildId && store.load().guilds[channel.guildId];
  if (!data || (!data.hubs[channel.id] && !data.rooms[channel.id])) return;
  delete data.hubs[channel.id];
  delete data.rooms[channel.id];
  store.save();
}

// At startup: forget what was deleted, delete channels that emptied while
// Spork was offline, and make channels for anyone already waiting in a hub.
async function init(client) {
  for (const [guildId, data] of Object.entries(store.load().guilds)) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;
    for (const id of Object.keys(data.hubs)) if (!guild.channels.cache.has(id)) delete data.hubs[id];
    for (const id of Object.keys(data.rooms)) {
      const channel = guild.channels.cache.get(id);
      if (!channel) delete data.rooms[id];
      else if (humansIn(channel) === 0) await removeRoom(guild, id, 'Join to Create: emptied while I was offline');
    }
    store.save();
    if (!access.isEnabled(guildId, 'tempvoice')) continue;
    for (const [id, settings] of Object.entries(data.hubs)) {
      const hub = guild.channels.cache.get(id);
      for (const member of hub?.members.values() ?? []) if (!member.user?.bot) await makeRoom(member, hub, settings);
    }
  }
}

// ---------------------------------------------------------------------------
// The buttons in a channel's chat
// ---------------------------------------------------------------------------

async function handleButton(interaction, action) {
  const say = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  const room = store.load().guilds[interaction.guildId]?.rooms[interaction.channelId];
  const channel = interaction.channel;
  if (!room || !channel) return say("This isn't a Join to Create channel anymore.");
  const isAdmin = Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
  const userId = interaction.user.id;
  let done;
  if (action === 'claim') {
    if (userId === room.ownerId) return say('This channel is already yours!');
    if (interaction.member?.voice?.channelId !== channel.id) return say('Join this voice channel first, then you can claim it.');
    if (channel.members.has(room.ownerId) && !isAdmin) return say(`<@${room.ownerId}> is still here - you can claim it after they leave.`);
    room.ownerId = userId;
    done = `👑 <@${userId}> is the new owner of this channel.`;
  } else if (action === 'lock' || action === 'unlock') {
    if (userId !== room.ownerId && !isAdmin) return say(`Only the owner, <@${room.ownerId}>, can ${action} this channel.`);
    room.locked = action === 'lock';
    done = room.locked ? `🔒 <@${userId}> locked the channel. Nobody new can join (people here now can come back).` : `🔓 <@${userId}> unlocked the channel. Anyone can join again.`;
  } else return;
  const insideIds = [...channel.members.keys()];
  await channel.permissionOverwrites.set(roomOverwrites(interaction.guild, channel.parent, room.ownerId, { locked: room.locked, insideIds }), `Join to Create: ${action} by ${interaction.user.tag ?? userId}`);
  store.save();
  console.log(`Join to Create: ${userId} used ${action} on channel ${channel.id}.`);
  return interaction.reply({ content: done, allowedMentions: { parse: [] } });
}

// ---------------------------------------------------------------------------
// /join-to-create
// ---------------------------------------------------------------------------

async function handleCommand(interaction) {
  if (interaction.commandName !== COMMAND.name) return false;
  const reply = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await reply('Only people with the **Manage Server** permission can use /join-to-create.');
    return true;
  }
  const { guild } = interaction;
  const data = guildData(guild.id);
  const sub = interaction.options.getSubcommand();
  const by = `${interaction.user.tag} (${interaction.user.id})`;
  const offNote = access.isEnabled(guild.id, 'tempvoice') ? '' : '\n⚠️ **Join to Create** is turned off right now. Turn it on with `/access feature feature:Join to Create on:True`.';

  if (sub === 'create' || sub === 'add') {
    const missing = missingPermissions(guild);
    if (missing.length) {
      await reply(`I need these permissions first: **${missing.join(', ')}**. Give them to my role in Server Settings → Roles.`);
      return true;
    }
    let hub;
    if (sub === 'add') {
      const picked = interaction.options.getChannel('channel', true);
      if (data.rooms[picked.id]) {
        await reply("That's one of the channels I made for someone - pick a different voice channel.");
        return true;
      }
      hub = guild.channels.cache.get(picked.id) ?? picked;
    } else {
      const picked = interaction.options.getChannel('category');
      const category = picked ? guild.channels.cache.get(picked.id) ?? picked : null;
      hub = await guild.channels.create({
        name: HUB_NAME,
        type: ChannelType.GuildVoice,
        parent: category?.id,
        // Same permissions as the category, like a synced channel.
        permissionOverwrites: category?.permissionOverwrites?.cache.map((o) => ({ id: o.id, type: o.type, allow: o.allow.bitfield, deny: o.deny.bitfield })),
        reason: `Join to Create, set up by ${by}`,
      });
    }
    const before = data.hubs[hub.id];
    data.hubs[hub.id] = {
      name: interaction.options.getString('name') ?? before?.name ?? DEFAULT_NAME,
      limit: interaction.options.getInteger('limit') ?? before?.limit ?? 0,
    };
    store.save();
    console.log(`/join-to-create: ${by} ${before ? 'changed' : 'added'} hub ${hub.id} in "${guild.name}".`);
    const { name, limit } = data.hubs[hub.id];
    await reply(
      `✅ <#${hub.id}> is a Join to Create channel! When someone joins it, I make them their own voice channel called **${name.replaceAll('{name}', interaction.member?.displayName ?? 'Name')}**${limit ? ` (for up to ${limit} people)` : ''} and move them in. It goes away when everyone leaves.${offNote}`
    );
  } else if (sub === 'remove') {
    const channel = interaction.options.getChannel('channel', true);
    if (!data.hubs[channel.id]) {
      await reply(`<#${channel.id}> isn't a Join to Create channel.`);
      return true;
    }
    delete data.hubs[channel.id];
    store.save();
    console.log(`/join-to-create: ${by} removed hub ${channel.id} in "${guild.name}".`);
    await reply(`<#${channel.id}> doesn't make voice channels anymore. I didn't delete it - you can do that in Server Settings if you don't need it.`);
  } else {
    const hubs = Object.entries(data.hubs).map(([id, { name, limit }]) => `<#${id}> → makes **${name}**${limit ? ` · up to ${limit} people` : ''}`);
    const rooms = Object.entries(data.rooms).map(([id, { ownerId, locked }]) => `<#${id}> · owner <@${ownerId}>${locked ? ' · 🔒 locked' : ''}`);
    await reply(
      [
        `**Join to Create:** ${access.isEnabled(guild.id, 'tempvoice') ? 'on' : 'off'}`,
        `**Join to Create channels:** ${hubs.length ? `\n${hubs.join('\n')}` : 'none yet - make one with `/join-to-create create`'}`,
        `**Channels open right now:** ${rooms.length ? `\n${rooms.join('\n')}` : 'none'}`,
      ].join('\n')
    );
  }
  return true;
}

// For /setup: the hubs, and replacing them from a menu pick.
const hubsIn = (guildId) => Object.keys(store.load().guilds[guildId]?.hubs ?? {});

function setHubs(guildId, channelIds) {
  const data = guildData(guildId);
  data.hubs = Object.fromEntries(channelIds.filter((id) => !data.rooms[id]).map((id) => [id, data.hubs[id] ?? { name: DEFAULT_NAME, limit: 0 }]));
  store.save();
}

module.exports = {
  commands: [COMMAND],
  handleCommand,
  handleButton,
  voiceStateChanged,
  channelDeleted,
  init,
  hubOf,
  hubsIn,
  setHubs,
  missingPermissions,
  // For previews.
  controlPanel,
};
