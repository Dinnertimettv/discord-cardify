// The mod log: a channel (set with /logs) where Cardify reports deleted and
// edited messages, bans and unbans, members joining and leaving (when the
// Server Members intent is on), and every /mod action. Saved in data/logs.json.
const {
  ChannelType,
  ContainerBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextDisplayBuilder,
} = require('discord.js');
const { createStore } = require('../store');
const access = require('./access');

const store = createStore('logs.json', { channels: {} });

const COLORS = {
  delete: 0xed4245,
  edit: 0xfee75c,
  join: 0x57f287,
  leave: 0x99aab5,
  ban: 0xa12d2f,
  mod: 0x5865f2,
};
const MAX_QUOTED = 900;

const LOGS_COMMAND = new SlashCommandBuilder()
  .setName('logs')
  .setDescription('The mod-log channel')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) =>
    sub
      .setName('set')
      .setDescription('Post the mod log in a channel')
      .addChannelOption((o) =>
        o.setName('channel').setDescription('The mod-log channel').setRequired(true).addChannelTypes(ChannelType.GuildText)
      )
  )
  .addSubcommand((sub) => sub.setName('off').setDescription('Stop the mod log'));

let client = null;
// Messages Cardify deletes itself (link reposts, /mod purge) - not news for the log.
const ownDeletions = new Set();

function init(discordClient) {
  client = discordClient;
}

function ignoreDeletion(messageId) {
  ownDeletions.add(messageId);
  // Deletion events arrive within seconds; don't keep ids forever.
  setTimeout(() => ownDeletions.delete(messageId), 60_000).unref?.();
}

function logChannelId(guildId) {
  return store.load().channels[guildId] ?? null;
}

// Posts one entry in the server's mod log, if it has one.
async function log(guildId, kind, text) {
  const channelId = logChannelId(guildId);
  if (!channelId || !client || !access.isEnabled(guildId, 'logs')) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;
  await channel
    .send({
      flags: MessageFlags.IsComponentsV2,
      components: [
        new ContainerBuilder()
          .setAccentColor(COLORS[kind] ?? COLORS.mod)
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${text}\n-# <t:${Math.floor(Date.now() / 1000)}:f>`)),
      ],
      allowedMentions: { parse: [] },
    })
    .catch((err) => console.error(`Couldn't post in the mod log of server ${guildId}:`, err.message));
}

function quote(text) {
  if (!text) return '> *(no text)*';
  const clipped = text.length > MAX_QUOTED ? `${text.slice(0, MAX_QUOTED - 1)}…` : text;
  return clipped
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

async function handleCommand(interaction) {
  if (interaction.commandName !== LOGS_COMMAND.name) return false;
  const reply = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await reply('Only people with the **Manage Server** permission can use /logs.');
    return true;
  }
  if (interaction.options.getSubcommand() === 'off') {
    delete store.load().channels[interaction.guildId];
    store.save();
    console.log(`/logs: ${interaction.user.tag} (${interaction.user.id}) turned the mod log off.`);
    await reply('The mod log is off.');
    return true;
  }
  const picked = interaction.options.getChannel('channel', true);
  const channel = interaction.guild.channels.cache.get(picked.id) ?? picked;
  if (!channel.permissionsFor?.(interaction.guild.members.me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
    await reply(`I can't post in <#${picked.id}> - give me View Channel and Send Messages there.`);
    return true;
  }
  store.load().channels[interaction.guildId] = picked.id;
  store.save();
  console.log(`/logs: ${interaction.user.tag} (${interaction.user.id}) set the mod log to channel ${picked.id}.`);
  await reply(`The mod log now goes to <#${picked.id}>. Keep that channel private to your mods - it shows deleted messages.`);
  await log(interaction.guildId, 'mod', `📋 **Mod log turned on** by <@${interaction.user.id}>.`);
  return true;
}

// ---------------------------------------------------------------------------
// Events (index.js forwards them here)
// ---------------------------------------------------------------------------

function messageDeleted(message) {
  if (!message.guildId || ownDeletions.has(message.id)) return;
  // Only messages seen since the bot started have their text; skip bots and webhooks.
  if (message.partial || message.author?.bot || message.webhookId) return;
  if (message.channelId === logChannelId(message.guildId)) return;
  const attachments = message.attachments?.size ? `\n-# 📎 ${message.attachments.size} attachment(s)` : '';
  return log(message.guildId, 'delete', `🗑️ **Message deleted** in <#${message.channelId}> · sent by <@${message.author.id}>\n${quote(message.content)}${attachments}`);
}

function messageEdited(before, after) {
  if (!after.guildId || before.partial || after.author?.bot || after.webhookId) return;
  // Link previews loading in also fire edits - only text changes count.
  if (before.content === after.content) return;
  return log(after.guildId, 'edit', `✏️ **Message edited** in <#${after.channelId}> by <@${after.author.id}> · [jump](${after.url})\n**Before**\n${quote(before.content)}\n**After**\n${quote(after.content)}`);
}

function memberJoined(member) {
  const age = Math.floor(member.user.createdTimestamp / 1000);
  return log(member.guild.id, 'join', `📥 <@${member.id}> **joined** · account created <t:${age}:R>`);
}

function memberLeft(member) {
  return log(member.guild.id, 'leave', `📤 <@${member.id}> (${member.user?.tag ?? member.id}) **left**`);
}

function memberBanned(ban) {
  return log(ban.guild.id, 'ban', `🔨 <@${ban.user.id}> (${ban.user.tag}) **was banned**${ban.reason ? `\n${quote(ban.reason)}` : ''}`);
}

function memberUnbanned(ban) {
  return log(ban.guild.id, 'mod', `🕊️ <@${ban.user.id}> (${ban.user.tag}) **was unbanned**`);
}

// For /setup.
function setLogChannel(guildId, channelId) {
  if (channelId) store.load().channels[guildId] = channelId;
  else delete store.load().channels[guildId];
  store.save();
}

module.exports = {
  commands: [LOGS_COMMAND],
  handleCommand,
  init,
  log,
  logChannelId,
  setLogChannel,
  ignoreDeletion,
  messageDeleted,
  messageEdited,
  memberJoined,
  memberLeft,
  memberBanned,
  memberUnbanned,
};
