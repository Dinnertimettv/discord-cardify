// Auto-mod, built on Discord's own AutoMod: /automod sets up rules that block
// words, invite links, spam, mass mentions, and profanity. Discord enforces
// them itself - instantly, and even while Spork is offline - and each rule
// also reports to the mod log when /logs is set. The rules are named
// "Spork · ..." and show up in Server Settings → AutoMod.
const {
  AutoModerationActionType,
  AutoModerationRuleEventType,
  AutoModerationRuleKeywordPresetType,
  AutoModerationRuleTriggerType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  SlashCommandBuilder,
} = require('discord.js');
const logs = require('./logs');

const RULES = {
  words: 'Blocked words',
  invites: 'Invite links',
  spam: 'Spam',
  mentions: 'Mass mentions',
  profanity: 'Profanity & slurs',
};
const RULE_PREFIX = 'Spork · ';
// Rules made under the bot's old name are still found, and renamed when changed.
const OLD_PREFIXES = ['Cardify · '];
const ruleName = (key) => `${RULE_PREFIX}${RULES[key]}`;
const isRule = (rule, key) => [RULE_PREFIX, ...OLD_PREFIXES].some((prefix) => rule.name === `${prefix}${RULES[key]}`);
// Discord's limit for one keyword in a filter.
const MAX_WORD_LENGTH = 60;
const INVITE_PATTERN = 'discord(?:\\.gg|(?:app)?\\.com/invite)/[a-zA-Z0-9-]+';

const onOff = (o) => o.setName('on').setDescription('On or off').setRequired(true);

const AUTOMOD_COMMAND = new SlashCommandBuilder()
  .setName('automod')
  .setDescription("Auto-mod rules, enforced by Discord's AutoMod")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) =>
    s
      .setName('words-add')
      .setDescription('Block words or phrases (use * as a wildcard, like *word*)')
      .addStringOption((o) => o.setName('words').setDescription('Comma-separated, like: word one, word two').setRequired(true))
  )
  .addSubcommand((s) =>
    s
      .setName('words-remove')
      .setDescription('Unblock words or phrases')
      .addStringOption((o) => o.setName('words').setDescription('Comma-separated').setRequired(true))
  )
  .addSubcommand((s) => s.setName('words-list').setDescription('See the blocked words'))
  .addSubcommand((s) => s.setName('invites').setDescription('Block Discord invite links to other servers').addBooleanOption(onOff))
  .addSubcommand((s) => s.setName('spam').setDescription("Block messages Discord detects as spam").addBooleanOption(onOff))
  .addSubcommand((s) =>
    s
      .setName('mentions')
      .setDescription('Block messages that mention too many people')
      .addIntegerOption((o) =>
        o.setName('limit').setDescription('Most mentions allowed in one message (0 = turn off)').setRequired(true).setMinValue(0).setMaxValue(50)
      )
  )
  .addSubcommand((s) =>
    s.setName('profanity').setDescription("Block profanity, slurs and sexual content (Discord's lists)").addBooleanOption(onOff)
  )
  .addSubcommand((s) => s.setName('status').setDescription("See which of Spork's auto-mod rules are on"));

function reply(interaction, content) {
  return interaction.editReply({ content, allowedMentions: { parse: [] } });
}

async function findRule(guild, key) {
  const rules = await guild.autoModerationRules.fetch();
  return rules.find((rule) => isRule(rule, key)) ?? null;
}

// Block the message, and report it in the mod log when there is one.
function ruleActions(guildId, customMessage) {
  const actions = [{ type: AutoModerationActionType.BlockMessage, metadata: { customMessage } }];
  const logChannel = logs.logChannelId(guildId);
  if (logChannel) actions.push({ type: AutoModerationActionType.SendAlertMessage, metadata: { channel: logChannel } });
  return actions;
}

// Creates the rule, or updates it if Spork made it before.
async function saveRule(interaction, key, { triggerType, triggerMetadata, message, enabled = true }) {
  const name = ruleName(key);
  const existing = await findRule(interaction.guild, key);
  const changes = {
    name,
    triggerMetadata,
    actions: ruleActions(interaction.guildId, message),
    enabled,
    reason: `Set by ${interaction.user.tag} with /automod`,
  };
  if (existing) return existing.edit(changes);
  return interaction.guild.autoModerationRules.create({
    eventType: AutoModerationRuleEventType.MessageSend,
    triggerType,
    ...changes,
  });
}

async function turnOff(interaction, key) {
  const existing = await findRule(interaction.guild, key);
  if (existing?.enabled) await existing.edit({ enabled: false, reason: `Turned off by ${interaction.user.tag} with /automod` });
}

function parseWords(text) {
  return [...new Set(text.split(',').map((word) => word.trim().toLowerCase()).filter(Boolean))];
}

const SUBCOMMANDS = {
  async 'words-add'(interaction) {
    const words = parseWords(interaction.options.getString('words', true));
    const tooLong = words.find((word) => word.length > MAX_WORD_LENGTH);
    if (tooLong) return reply(interaction, `"${tooLong}" is too long - Discord allows at most ${MAX_WORD_LENGTH} characters per word.`);
    const existing = await findRule(interaction.guild, 'words');
    const list = [...new Set([...(existing?.triggerMetadata.keywordFilter ?? []), ...words])];
    await saveRule(interaction, 'words', {
      triggerType: AutoModerationRuleTriggerType.Keyword,
      triggerMetadata: { keywordFilter: list },
      message: "That message was blocked by this server's word filter.",
    });
    return reply(interaction, `Blocking ${list.length} word(s) now.`);
  },

  async 'words-remove'(interaction) {
    const words = parseWords(interaction.options.getString('words', true));
    const existing = await findRule(interaction.guild, 'words');
    if (!existing) return reply(interaction, 'No words are blocked yet.');
    const list = existing.triggerMetadata.keywordFilter.filter((word) => !words.includes(word));
    if (list.length === 0) {
      await turnOff(interaction, 'words');
      return reply(interaction, 'No words are blocked anymore - the word filter is off.');
    }
    await existing.edit({ name: ruleName('words'), triggerMetadata: { keywordFilter: list }, reason: `Changed by ${interaction.user.tag} with /automod` });
    return reply(interaction, `Blocking ${list.length} word(s) now.`);
  },

  async 'words-list'(interaction) {
    const existing = await findRule(interaction.guild, 'words');
    const list = existing?.enabled ? existing.triggerMetadata.keywordFilter : [];
    if (list.length === 0) return reply(interaction, 'No words are blocked.');
    return reply(interaction, `Blocked (${list.length}): ${list.map((word) => `||${word}||`).join(', ')}`.slice(0, 2000));
  },

  async invites(interaction) {
    if (!interaction.options.getBoolean('on', true)) {
      await turnOff(interaction, 'invites');
      return reply(interaction, 'Invite links are allowed again.');
    }
    await saveRule(interaction, 'invites', {
      triggerType: AutoModerationRuleTriggerType.Keyword,
      triggerMetadata: { regexPatterns: [INVITE_PATTERN] },
      message: "Invite links to other servers aren't allowed here.",
    });
    return reply(interaction, 'Invite links to other servers are blocked now.');
  },

  async spam(interaction) {
    if (!interaction.options.getBoolean('on', true)) {
      await turnOff(interaction, 'spam');
      return reply(interaction, 'The spam filter is off.');
    }
    await saveRule(interaction, 'spam', {
      triggerType: AutoModerationRuleTriggerType.Spam,
      triggerMetadata: {},
      message: 'That message looked like spam, so it was blocked.',
    });
    return reply(interaction, 'Messages Discord detects as spam are blocked now.');
  },

  async mentions(interaction) {
    const limit = interaction.options.getInteger('limit', true);
    if (limit === 0) {
      await turnOff(interaction, 'mentions');
      return reply(interaction, 'The mention limit is off.');
    }
    await saveRule(interaction, 'mentions', {
      triggerType: AutoModerationRuleTriggerType.MentionSpam,
      triggerMetadata: { mentionTotalLimit: limit, mentionRaidProtectionEnabled: true },
      message: `Messages can mention at most ${limit} people or roles here.`,
    });
    return reply(interaction, `Messages mentioning more than ${limit} people or roles are blocked now (plus Discord's mention-raid protection).`);
  },

  async profanity(interaction) {
    if (!interaction.options.getBoolean('on', true)) {
      await turnOff(interaction, 'profanity');
      return reply(interaction, 'The profanity filter is off.');
    }
    await saveRule(interaction, 'profanity', {
      triggerType: AutoModerationRuleTriggerType.KeywordPreset,
      triggerMetadata: {
        presets: [
          AutoModerationRuleKeywordPresetType.Profanity,
          AutoModerationRuleKeywordPresetType.Slurs,
          AutoModerationRuleKeywordPresetType.SexualContent,
        ],
      },
      message: "That message was blocked by this server's language filter.",
    });
    return reply(interaction, "Profanity, slurs and sexual content are blocked now (Discord's own word lists).");
  },

  async status(interaction) {
    const rules = await interaction.guild.autoModerationRules.fetch();
    const lines = Object.entries(RULES).map(([key, label]) => {
      const rule = rules.find((r) => isRule(r, key));
      const detail =
        key === 'words' && rule ? ` (${rule.triggerMetadata.keywordFilter.length} words)` : key === 'mentions' && rule ? ` (max ${rule.triggerMetadata.mentionTotalLimit})` : '';
      return `${rule?.enabled ? '🟢' : '⚫'} **${label}**${rule?.enabled ? detail : ' - off'}`;
    });
    const logChannel = logs.logChannelId(interaction.guildId);
    lines.push(`-# Blocked messages are reported in ${logChannel ? `<#${logChannel}>` : 'the mod log, once you set one with `/logs set`'}. Mods and admins aren't affected.`);
    return reply(interaction, lines.join('\n'));
  },
};

async function handleCommand(interaction) {
  if (interaction.commandName !== AUTOMOD_COMMAND.name) return false;
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: 'Only people with the **Manage Server** permission can use /automod.', flags: MessageFlags.Ephemeral });
    return true;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const sub = interaction.options.getSubcommand();
  try {
    await SUBCOMMANDS[sub](interaction);
    if (sub !== 'status' && sub !== 'words-list') {
      console.log(`/automod: ${interaction.user.tag} (${interaction.user.id}) ran ${sub}.`);
      await logs.log(interaction.guildId, 'mod', `🛡️ <@${interaction.user.id}> changed auto-mod: \`/automod ${sub}\``);
    }
  } catch (err) {
    const why =
      err.code === RESTJSONErrorCodes.MissingPermissions
        ? 'I need the **Manage Server** permission to set up AutoMod rules.'
        : `Discord wouldn't save that rule: ${err.message}`;
    await reply(interaction, why);
  }
  return true;
}

module.exports = { commands: [AUTOMOD_COMMAND], handleCommand, RULES };
