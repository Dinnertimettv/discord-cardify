// Moderation commands: /mod warn, warnings, clear-warnings, timeout,
// untimeout, kick, ban, unban and purge. Each needs the matching Discord
// permission, never touches the owner or anyone with an equal or higher
// role, DMs the member why (when it can), and is reported in the mod log.
// Warnings are saved in data/moderation.json.
const { InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { createStore } = require('../store');
const logs = require('./logs');

const store = createStore('moderation.json', { warnings: {} });

const DURATIONS = {
  '60s': 60_000,
  '5m': 5 * 60_000,
  '10m': 10 * 60_000,
  '1h': 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '1w': 7 * 24 * 60 * 60_000,
};
const DURATION_NAMES = { '60s': '60 seconds', '5m': '5 minutes', '10m': '10 minutes', '1h': '1 hour', '1d': '1 day', '1w': '1 week' };

// The permission each subcommand needs.
const NEEDS = {
  warn: [PermissionFlagsBits.ModerateMembers, 'Timeout Members'],
  warnings: [PermissionFlagsBits.ModerateMembers, 'Timeout Members'],
  'clear-warnings': [PermissionFlagsBits.ModerateMembers, 'Timeout Members'],
  timeout: [PermissionFlagsBits.ModerateMembers, 'Timeout Members'],
  untimeout: [PermissionFlagsBits.ModerateMembers, 'Timeout Members'],
  kick: [PermissionFlagsBits.KickMembers, 'Kick Members'],
  ban: [PermissionFlagsBits.BanMembers, 'Ban Members'],
  unban: [PermissionFlagsBits.BanMembers, 'Ban Members'],
  purge: [PermissionFlagsBits.ManageMessages, 'Manage Messages'],
};

const user = (o, description = 'The member') => o.setName('member').setDescription(description).setRequired(true);
const reason = (o) => o.setName('reason').setDescription('Why (they see this)').setMaxLength(400);

const MOD_COMMAND = new SlashCommandBuilder()
  .setName('mod')
  .setDescription('Moderation tools')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) => s.setName('warn').setDescription('Warn a member').addUserOption(user).addStringOption((o) => reason(o).setRequired(true)))
  .addSubcommand((s) => s.setName('warnings').setDescription("See a member's warnings").addUserOption(user))
  .addSubcommand((s) => s.setName('clear-warnings').setDescription("Clear a member's warnings").addUserOption(user))
  .addSubcommand((s) =>
    s
      .setName('timeout')
      .setDescription("Time a member out (they can't talk or join voice)")
      .addUserOption(user)
      .addStringOption((o) =>
        o
          .setName('duration')
          .setDescription('How long')
          .setRequired(true)
          .addChoices(...Object.entries(DURATION_NAMES).map(([value, name]) => ({ name, value })))
      )
      .addStringOption(reason)
  )
  .addSubcommand((s) => s.setName('untimeout').setDescription("End a member's timeout").addUserOption(user))
  .addSubcommand((s) => s.setName('kick').setDescription('Kick a member (they can rejoin with an invite)').addUserOption(user).addStringOption(reason))
  .addSubcommand((s) =>
    s
      .setName('ban')
      .setDescription('Ban someone from the server')
      .addUserOption((o) => user(o, 'The member (or paste a user ID)'))
      .addStringOption(reason)
      .addIntegerOption((o) =>
        o.setName('delete-days').setDescription('Also delete their messages from the last 0-7 days (default 0)').setMinValue(0).setMaxValue(7)
      )
  )
  .addSubcommand((s) => s.setName('unban').setDescription('Unban someone').addUserOption((o) => user(o, 'Their user ID')))
  .addSubcommand((s) =>
    s
      .setName('purge')
      .setDescription('Delete recent messages in this channel')
      .addIntegerOption((o) => o.setName('count').setDescription('How many of the latest messages to check (1-100)').setRequired(true).setMinValue(1).setMaxValue(100))
      .addUserOption((o) => o.setName('member').setDescription("Only delete this member's messages"))
  );

function reply(interaction, content) {
  const payload = { content, allowedMentions: { parse: [] } };
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

function warningsOf(guildId, userId) {
  const all = store.load().warnings;
  all[guildId] ??= {};
  all[guildId][userId] ??= [];
  return all[guildId][userId];
}

// Why the moderator can't act on this member, or null if they can.
function hierarchyProblem(interaction, target, action) {
  if (target.id === interaction.user.id) return `You can't ${action} yourself.`;
  if (target.id === interaction.client.user.id) return `I can't ${action} myself.`;
  if (target.id === interaction.guild.ownerId) return `Nobody can ${action} the server owner.`;
  const isOwner = interaction.user.id === interaction.guild.ownerId;
  if (!isOwner && target.roles.highest.position >= interaction.member.roles.highest.position) {
    return `<@${target.id}> has the same or a higher role than you, so you can't ${action} them.`;
  }
  return null;
}

async function dm(user, text) {
  return user.send({ content: text, allowedMentions: { parse: [] } }).then(() => true, () => false);
}

async function handleCommand(interaction) {
  if (interaction.commandName !== MOD_COMMAND.name) return false;
  const sub = interaction.options.getSubcommand();
  const [permission, permissionName] = NEEDS[sub];
  if (!interaction.memberPermissions?.has(permission)) {
    await reply(interaction, `You need the **${permissionName}** permission for that.`);
    return true;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await ACTIONS[sub](interaction);
  return true;
}

const by = (interaction) => `<@${interaction.user.id}>`;
const because = (text) => (text ? `\n> ${text.replace(/\n/g, '\n> ')}` : '');

const ACTIONS = {
  async warn(interaction) {
    const member = interaction.options.getMember('member');
    if (!member) return reply(interaction, "They're not in this server.");
    const problem = hierarchyProblem(interaction, member, 'warn');
    if (problem) return reply(interaction, problem);
    const reasonText = interaction.options.getString('reason', true);
    const list = warningsOf(interaction.guildId, member.id);
    list.push({ reason: reasonText, by: interaction.user.id, at: Date.now() });
    store.save();
    const told = await dm(member.user, `⚠️ You were warned in **${interaction.guild.name}**: ${reasonText}`);
    await logs.log(interaction.guildId, 'mod', `⚠️ ${by(interaction)} **warned** <@${member.id}> (warning #${list.length})${because(reasonText)}`);
    return reply(interaction, `Warned <@${member.id}> - that's warning #${list.length}.${told ? '' : " (Their DMs are closed, so they weren't told.)"}`);
  },

  async warnings(interaction) {
    const target = interaction.options.getUser('member', true);
    const list = warningsOf(interaction.guildId, target.id);
    if (list.length === 0) return reply(interaction, `<@${target.id}> has no warnings.`);
    const lines = list.map((w, i) => `**${i + 1}.** <t:${Math.floor(w.at / 1000)}:d> by <@${w.by}>: ${w.reason}`);
    return reply(interaction, [`<@${target.id}> has ${list.length} warning(s):`, ...lines].join('\n').slice(0, 2000));
  },

  async 'clear-warnings'(interaction) {
    const target = interaction.options.getUser('member', true);
    const count = warningsOf(interaction.guildId, target.id).length;
    delete store.load().warnings[interaction.guildId][target.id];
    store.save();
    if (count) await logs.log(interaction.guildId, 'mod', `🧽 ${by(interaction)} **cleared ${count} warning(s)** of <@${target.id}>`);
    return reply(interaction, count ? `Cleared ${count} warning(s) of <@${target.id}>.` : `<@${target.id}> had no warnings.`);
  },

  async timeout(interaction) {
    const member = interaction.options.getMember('member');
    if (!member) return reply(interaction, "They're not in this server.");
    const problem = hierarchyProblem(interaction, member, 'time out');
    if (problem) return reply(interaction, problem);
    if (!member.moderatable) return reply(interaction, `I can't time out <@${member.id}> - my role needs to be above theirs.`);
    const duration = interaction.options.getString('duration', true);
    const reasonText = interaction.options.getString('reason');
    await member.timeout(DURATIONS[duration], `${interaction.user.tag}: ${reasonText ?? 'no reason given'}`);
    await dm(member.user, `⏳ You were timed out in **${interaction.guild.name}** for ${DURATION_NAMES[duration]}${reasonText ? `: ${reasonText}` : '.'}`);
    await logs.log(interaction.guildId, 'mod', `⏳ ${by(interaction)} **timed out** <@${member.id}> for ${DURATION_NAMES[duration]}${because(reasonText)}`);
    return reply(interaction, `Timed out <@${member.id}> for ${DURATION_NAMES[duration]}.`);
  },

  async untimeout(interaction) {
    const member = interaction.options.getMember('member');
    if (!member) return reply(interaction, "They're not in this server.");
    if (!member.isCommunicationDisabled()) return reply(interaction, `<@${member.id}> isn't timed out.`);
    if (!member.moderatable) return reply(interaction, `I can't change <@${member.id}>'s timeout - my role needs to be above theirs.`);
    await member.timeout(null, `${interaction.user.tag}: timeout ended early`);
    await logs.log(interaction.guildId, 'mod', `✅ ${by(interaction)} **ended the timeout** of <@${member.id}>`);
    return reply(interaction, `Ended <@${member.id}>'s timeout.`);
  },

  async kick(interaction) {
    const member = interaction.options.getMember('member');
    if (!member) return reply(interaction, "They're not in this server.");
    const problem = hierarchyProblem(interaction, member, 'kick');
    if (problem) return reply(interaction, problem);
    if (!member.kickable) return reply(interaction, `I can't kick <@${member.id}> - my role needs to be above theirs.`);
    const reasonText = interaction.options.getString('reason');
    // Told before they're gone - afterwards there's no shared server to DM through.
    await dm(member.user, `👢 You were kicked from **${interaction.guild.name}**${reasonText ? `: ${reasonText}` : '.'}`);
    await member.kick(`${interaction.user.tag}: ${reasonText ?? 'no reason given'}`);
    await logs.log(interaction.guildId, 'mod', `👢 ${by(interaction)} **kicked** <@${member.id}> (${member.user.tag})${because(reasonText)}`);
    return reply(interaction, `Kicked <@${member.id}>.`);
  },

  async ban(interaction) {
    const target = interaction.options.getUser('member', true);
    const member = interaction.options.getMember('member');
    if (member) {
      const problem = hierarchyProblem(interaction, member, 'ban');
      if (problem) return reply(interaction, problem);
      if (!member.bannable) return reply(interaction, `I can't ban <@${member.id}> - my role needs to be above theirs.`);
    } else if (target.id === interaction.guild.ownerId || target.id === interaction.user.id) {
      return reply(interaction, "You can't ban them.");
    }
    const reasonText = interaction.options.getString('reason');
    if (member) await dm(target, `🔨 You were banned from **${interaction.guild.name}**${reasonText ? `: ${reasonText}` : '.'}`);
    const days = interaction.options.getInteger('delete-days') ?? 0;
    // The ban itself shows up in the mod log (with this reason) via the ban event.
    await interaction.guild.members.ban(target.id, {
      reason: `${interaction.user.tag}: ${reasonText ?? 'no reason given'}`,
      deleteMessageSeconds: days * 24 * 60 * 60,
    });
    return reply(interaction, `Banned <@${target.id}>${days ? ` and deleted their messages from the last ${days} day(s)` : ''}.`);
  },

  async unban(interaction) {
    const target = interaction.options.getUser('member', true);
    const ban = await interaction.guild.bans.fetch(target.id).catch(() => null);
    if (!ban) return reply(interaction, `<@${target.id}> isn't banned.`);
    // Shows up in the mod log via the unban event.
    await interaction.guild.members.unban(target.id, `${interaction.user.tag}: unbanned with /mod`);
    return reply(interaction, `Unbanned <@${target.id}>. They can rejoin with an invite.`);
  },

  async purge(interaction) {
    const count = interaction.options.getInteger('count', true);
    const only = interaction.options.getUser('member');
    const recent = await interaction.channel.messages.fetch({ limit: count });
    const doomed = recent.filter((message) => !message.pinned && (!only || message.author.id === only.id));
    for (const id of doomed.keys()) logs.ignoreDeletion(id);
    // Discord only bulk-deletes messages younger than 14 days.
    const deleted = await interaction.channel.bulkDelete(doomed, true);
    const skipped = doomed.size - deleted.size;
    await logs.log(
      interaction.guildId,
      'delete',
      `🧹 ${by(interaction)} **deleted ${deleted.size} message(s)** in <#${interaction.channelId}>${only ? ` from <@${only.id}>` : ''}`
    );
    return reply(
      interaction,
      `Deleted ${deleted.size} message(s).${skipped ? ` ${skipped} were older than 14 days, which Discord doesn't allow bots to bulk-delete.` : ''}`
    );
  },
};

module.exports = { commands: [MOD_COMMAND], handleCommand };
