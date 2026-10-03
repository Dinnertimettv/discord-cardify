// /setup: a step-by-step guide for admins, made of menus - pick an answer and
// it's saved right away. /access: who can use what, and where, one change at
// a time. Both are for people with Manage Server; the rules themselves live
// in access.js.
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ContainerBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  SeparatorBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
} = require('discord.js');
const access = require('./access');
const logs = require('./logs');
const welcome = require('./welcome');
const leveling = require('./leveling');
const music = require('./music');
const alerts = require('./alerts');

const SETUP_COLOR = 0x57f287;
const ACCESS_COLOR = 0x5865f2;
const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const COMMAND_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildStageVoice, ChannelType.GuildForum];

const SETUP_COMMAND = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('A step-by-step guide to set me up for this server')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild);

const whatOption = (o) => o.setName('what').setDescription('A feature, one command, or everything').setRequired(true).setAutocomplete(true);

const ACCESS_COMMAND = new SlashCommandBuilder()
  .setName('access')
  .setDescription('Choose who can use what, and where')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) => s.setName('view').setDescription('See who can use what, and where I post'))
  .addSubcommand((s) =>
    s
      .setName('feature')
      .setDescription('Turn one of my features on or off')
      .addStringOption((o) =>
        o
          .setName('feature')
          .setDescription('Which feature')
          .setRequired(true)
          .addChoices(...access.FEATURES.map((feature) => ({ name: `${feature.emoji} ${feature.name}`, value: feature.key })))
      )
      .addBooleanOption((o) => o.setName('on').setDescription('On or off').setRequired(true))
  )
  .addSubcommand((s) =>
    s
      .setName('add-role')
      .setDescription('Only let some roles use something (add one role at a time)')
      .addStringOption(whatOption)
      .addRoleOption((o) => o.setName('role').setDescription('The role that can use it').setRequired(true))
  )
  .addSubcommand((s) =>
    s
      .setName('remove-role')
      .setDescription('Take a role off the list')
      .addStringOption(whatOption)
      .addRoleOption((o) => o.setName('role').setDescription('The role to take off').setRequired(true))
  )
  .addSubcommand((s) =>
    s
      .setName('add-channel')
      .setDescription('Only let something work in some channels (add one channel at a time)')
      .addStringOption(whatOption)
      .addChannelOption((o) => o.setName('channel').setDescription('A channel where it works').setRequired(true).addChannelTypes(...COMMAND_CHANNELS))
  )
  .addSubcommand((s) =>
    s
      .setName('remove-channel')
      .setDescription('Take a channel off the list')
      .addStringOption(whatOption)
      .addChannelOption((o) => o.setName('channel').setDescription('The channel to take off').setRequired(true).addChannelTypes(...COMMAND_CHANNELS))
  )
  .addSubcommand((s) =>
    s
      .setName('quiet-channel')
      .setDescription('Make me ignore a channel: no link cards, no XP, no commands')
      .addChannelOption((o) => o.setName('channel').setDescription('The channel').setRequired(true).addChannelTypes(...COMMAND_CHANNELS))
      .addBooleanOption((o) => o.setName('quiet').setDescription('Stay quiet there?').setRequired(true))
  )
  .addSubcommand((s) => s.setName('reset').setDescription('Let everyone use something, everywhere, again').addStringOption(whatOption));

const isAdmin = (interaction) => Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
const by = (interaction) => `${interaction.user.tag} (${interaction.user.id})`;
const text = (content) => new TextDisplayBuilder().setContent(content);
const row = (...components) => new ActionRowBuilder().addComponents(...components);
const button = (id, label, emoji, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style);

// Default picks in a menu must still exist, or Discord refuses the menu.
const existingChannels = (guild, ids) => ids.filter((id) => id && guild.channels.cache.has(id));
const existingRoles = (guild, ids) => ids.filter((id) => id && guild.roles.cache.has(id));

function channelMenu(guild, id, { placeholder, types = TEXT_CHANNELS, max = 1, picked = [] }) {
  const menu = new ChannelSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder).setChannelTypes(...types).setMinValues(0).setMaxValues(max);
  const defaults = existingChannels(guild, picked).slice(0, max);
  if (defaults.length) menu.setDefaultChannels(...defaults);
  return row(menu);
}

function roleMenu(guild, id, { placeholder, max = 25, picked = [] }) {
  const menu = new RoleSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder).setMinValues(0).setMaxValues(max);
  const defaults = existingRoles(guild, picked).slice(0, max);
  if (defaults.length) menu.setDefaultRoles(...defaults);
  return row(menu);
}

function canPost(guild, channelId) {
  const channel = guild.channels.cache.get(channelId);
  return Boolean(channel?.permissionsFor?.(guild.members.me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]));
}

// ---------------------------------------------------------------------------
// Where Cardify posts - shown at the end of /setup and in /access view
// ---------------------------------------------------------------------------

function postingLines(guild) {
  const on = (key) => access.isEnabled(guild.id, key);
  const off = ' *(turned off)*';
  const channel = (id) => (id ? `<#${id}>` : null);
  const guildAlerts = alerts.alertsIn(guild.id);
  const alertChannels = [...new Set(guildAlerts.map((alert) => alert.channelId))].map((id) => `<#${id}>`);
  const { voiceChannels } = music.musicSettings(guild.id);
  return [
    `🔗 **Link cards:** right where a link is shared${on('links') ? '' : off}`,
    `🎭 **Role panels:** where you make them with \`/roles create\`${on('roles') ? '' : off}`,
    `🔴 **Alerts:** ${guildAlerts.length ? `${guildAlerts.length} alert${guildAlerts.length === 1 ? '' : 's'}, in ${alertChannels.join(', ')}` : 'none yet - add one with `/alerts`'}${on('alerts') ? '' : off}`,
    `📋 **Mod log:** ${channel(logs.logChannelId(guild.id)) ?? 'not set'}${on('logs') ? '' : off}`,
    `👋 **Welcome:** ${channel(welcome.channelFor(guild.id, 'welcome')) ?? 'not set'} · 🚪 **Goodbye:** ${channel(welcome.channelFor(guild.id, 'goodbye')) ?? 'not set'}${on('welcome') ? '' : off}`,
    `⭐ **Level-ups:** ${channel(leveling.announceChannel(guild.id)) ?? 'where the person is chatting'}${on('leveling') ? '' : off}`,
    `🎵 **Music:** the "Now playing" card goes where someone uses \`/play\`; I join ${voiceChannels.length ? voiceChannels.map((id) => `<#${id}>`).join(', ') : 'any voice channel'}${on('music') ? '' : off}`,
  ];
}

function ruleText(guildId, target) {
  const rule = access.ruleFor(guildId, target);
  return `${rule.channels.length ? `only in ${access.mentionChannels(rule.channels)}` : 'every channel'} · ${rule.roles.length ? `only ${access.mentionRoles(rule.roles)}` : 'everyone'}`;
}

function accessView(guild, { showPosting }) {
  const guildId = guild.id;
  const quiet = access.ignoredChannels(guildId);
  const lines = [
    '## 🔐 Who can use what',
    `**🙈 Quiet channels** (I ignore them): ${quiet.length ? access.mentionChannels(quiet) : 'none'}`,
    `**🌐 All my commands:** ${ruleText(guildId, 'all')}`,
    '',
  ];
  for (const feature of access.FEATURES) {
    const enabled = access.isEnabled(guildId, feature.key);
    lines.push(`${enabled ? '✅' : '⛔'} ${feature.emoji} **${feature.name}** - ${enabled ? ruleText(guildId, `feature:${feature.key}`) : 'turned off'}`);
    for (const command of feature.commands) {
      const rule = access.ruleFor(guildId, `command:${command}`);
      if (rule.channels.length || rule.roles.length) lines.push(`   ↳ \`/${command}\` - ${ruleText(guildId, `command:${command}`)}`);
    }
  }
  const container = new ContainerBuilder().setAccentColor(ACCESS_COLOR).addTextDisplayComponents(text(lines.join('\n')));
  if (showPosting) container.addSeparatorComponents(new SeparatorBuilder()).addTextDisplayComponents(text(['### 📣 Where I post', ...postingLines(guild)].join('\n')));
  container.addTextDisplayComponents(
    text('-# People who can manage the server can always use every command (channel limits still count). `/help`, `/setup` and `/access` always work. Change things with `/access` or `/setup`.')
  );
  return { flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [container], allowedMentions: { parse: [] } };
}

// ---------------------------------------------------------------------------
// /setup - the steps
// ---------------------------------------------------------------------------

const STEPS = ['start', 'jobs', 'posting', 'places', 'people', 'music', 'done'];
const STEP_OF_FIELD = {
  jobs: 'jobs',
  logs: 'posting',
  welcome: 'posting',
  goodbye: 'posting',
  levelups: 'posting',
  commands: 'places',
  quiet: 'places',
  linkchannels: 'places',
  musicroles: 'people',
  dj: 'people',
  levelroles: 'people',
  linkroles: 'people',
  voice: 'music',
  volume: 'music',
};

function stepControls(step, guild) {
  const id = guild.id;
  const on = (key) => access.isEnabled(id, key);
  const parts = []; // TextDisplays and ActionRows, in order
  const ask = (label, menu) => parts.push(text(label), menu);

  if (step === 'jobs') {
    const menu = new StringSelectMenuBuilder()
      .setCustomId('setup:set:jobs')
      .setPlaceholder('Tick the jobs you want me to do...')
      .setMinValues(0)
      .setMaxValues(access.FEATURES.length)
      .addOptions(access.FEATURES.map((feature) => ({ label: feature.name, value: feature.key, emoji: feature.emoji, description: feature.short.slice(0, 100), default: on(feature.key) })));
    ask('**What should I do here?** Open the menu and tick everything you want. Anything you leave empty gets turned off.', row(menu));
    parts.push(text(access.FEATURES.map((feature) => `${on(feature.key) ? '✅' : '⬜'} ${feature.emoji} ${feature.name}`).join('\n')));
  } else if (step === 'posting') {
    const warnings = [];
    if (on('logs')) {
      ask('📋 **Mod log** - where I write down deleted messages, bans and more. *Pick a private channel only mods can see!*', channelMenu(guild, 'setup:set:logs', { placeholder: 'Pick the mod log channel...', picked: [logs.logChannelId(id)] }));
    }
    if (on('welcome')) {
      ask('👋 **Welcome** - where I say hi to new members.', channelMenu(guild, 'setup:set:welcome', { placeholder: 'Pick the welcome channel...', picked: [welcome.channelFor(id, 'welcome')] }));
      ask('🚪 **Goodbye** - where I say bye when someone leaves.', channelMenu(guild, 'setup:set:goodbye', { placeholder: 'Pick the goodbye channel...', picked: [welcome.channelFor(id, 'goodbye')] }));
      if (!welcome.membersIntentOn()) warnings.push("⚠️ I can't see people join or leave yet. Whoever runs me needs to turn on **Server Members Intent** in the Discord Developer Portal (on the Bot page), then restart me.");
    }
    if (on('leveling')) {
      ask('⭐ **Level-ups** - where I cheer when someone levels up. *Pick nothing to cheer right where they are chatting.*', channelMenu(guild, 'setup:set:levelups', { placeholder: 'Pick the level-up channel...', picked: [leveling.announceChannel(id)] }));
    }
    if (parts.length === 0) parts.push(text('None of the jobs you picked need a channel. Press **Next**!'));
    const picked = [logs.logChannelId(id), welcome.channelFor(id, 'welcome'), welcome.channelFor(id, 'goodbye'), leveling.announceChannel(id)].filter(Boolean);
    for (const channelId of new Set(picked)) {
      if (!canPost(guild, channelId)) warnings.push(`⚠️ I can't post in <#${channelId}> yet. Give me **View Channel** and **Send Messages** there.`);
    }
    if (on('alerts')) parts.push(text('-# 🔴 Live alerts pick their own channel when you make one with `/alerts twitch` or `/alerts youtube`.'));
    if (warnings.length) parts.push(text(warnings.join('\n')));
  } else if (step === 'places') {
    ask(
      '💬 **Where can people use my commands?** Pick channels, or pick nothing to allow every channel.',
      channelMenu(guild, 'setup:set:commands', { placeholder: 'Every channel (pick some to limit it)...', types: COMMAND_CHANNELS, max: 25, picked: access.ruleFor(id, 'all').channels })
    );
    ask(
      "🙈 **Where should I stay quiet?** I won't make link cards, give XP, or answer commands there.",
      channelMenu(guild, 'setup:set:quiet', { placeholder: 'No quiet channels (pick some)...', types: COMMAND_CHANNELS, max: 25, picked: access.ignoredChannels(id) })
    );
    if (on('links')) {
      ask(
        '🔗 **Where should I make link cards?** Pick nothing to make them everywhere.',
        channelMenu(guild, 'setup:set:linkchannels', { placeholder: 'Everywhere (pick some to limit it)...', types: COMMAND_CHANNELS, max: 25, picked: access.ruleFor(id, 'feature:links').channels })
      );
    }
    parts.push(text('-# `/setup`, `/access` and `/help` work in every channel, so you can always change this later.'));
  } else if (step === 'people') {
    if (on('music')) {
      ask('🎵 **Who can play music?** Pick roles, or pick nothing to let everyone.', roleMenu(guild, 'setup:set:musicroles', { placeholder: 'Everyone (pick roles to limit it)...', picked: access.ruleFor(id, 'feature:music').roles }));
      ask("🎧 **Who are the DJs?** DJs can skip or stop anyone's songs. Pick nothing to let every listener do it.", roleMenu(guild, 'setup:set:dj', { placeholder: 'No DJ role (pick one)...', max: 1, picked: [music.musicSettings(id).djRoleId] }));
    }
    if (on('leveling')) {
      ask('⭐ **Who can earn levels?** Pick roles, or pick nothing to let everyone.', roleMenu(guild, 'setup:set:levelroles', { placeholder: 'Everyone (pick roles to limit it)...', picked: access.ruleFor(id, 'feature:leveling').roles }));
    }
    if (on('links')) {
      ask("🔗 **Whose links should I turn into cards?** Pick roles, or pick nothing for everyone's links.", roleMenu(guild, 'setup:set:linkroles', { placeholder: 'Everyone (pick roles to limit it)...', picked: access.ruleFor(id, 'feature:links').roles }));
    }
    if (parts.length === 0) parts.push(text('Nothing to pick here for the jobs you chose. Press **Next**!'));
    parts.push(text('-# People who can manage the server can always use every command. For anything else, use `/access add-role`.'));
  } else if (step === 'music') {
    if (on('music')) {
      const settings = music.musicSettings(id);
      ask(
        '🔊 **Which voice channels can I play music in?** Pick nothing to allow all of them.',
        channelMenu(guild, 'setup:set:voice', { placeholder: 'Any voice channel (pick some to limit it)...', types: [ChannelType.GuildVoice], max: 25, picked: settings.voiceChannels })
      );
      const volume = new StringSelectMenuBuilder()
        .setCustomId('setup:set:volume')
        .setPlaceholder('How loud?')
        .addOptions([25, 50, 60, 75, 100].map((percent) => ({ label: `${percent}%${percent === 60 ? ' (normal)' : ''}`, value: String(percent), emoji: percent <= 25 ? '🔈' : percent <= 60 ? '🔉' : '🔊', default: settings.volume === percent })));
      ask('🔉 **How loud should music start?** (People can still change it with `/music volume`.)', row(volume));
    } else {
      parts.push(text('🎵 Music is turned off, so there is nothing to pick here. Press **Next**!'));
    }
  }
  return parts;
}

const STEP_TEXT = {
  start: [
    "## 👋 Hi! Let's set up Cardify",
    'I will ask you a few easy questions. It takes about 2 minutes.',
    'Everything you pick is saved right away, and you can change it any time.',
    '',
    '**Here is the plan:**',
    '1️⃣ **Pick my jobs** - what should I do here?',
    '2️⃣ **Pick where I post** - logs, welcomes and level-ups',
    '3️⃣ **Pick where I work** - channels to use, and channels to skip',
    '4️⃣ **Pick who can use what** - roles for music, levels and links',
    '5️⃣ **Pick music rooms** - voice channels for music',
  ].join('\n'),
  jobs: '## 1️⃣ Pick my jobs\n-# Step 1 of 5',
  posting: '## 2️⃣ Pick where I post\n-# Step 2 of 5\nPick a channel for each one. To stop one, open its menu and take the channel off.',
  places: '## 3️⃣ Pick where I work\n-# Step 3 of 5',
  people: '## 4️⃣ Pick who can use what\n-# Step 4 of 5',
  music: '## 5️⃣ Pick music rooms\n-# Step 5 of 5',
};

function doneText(guild) {
  const on = access.FEATURES.filter((feature) => access.isEnabled(guild.id, feature.key));
  const off = access.FEATURES.filter((feature) => !access.isEnabled(guild.id, feature.key));
  const tips = [
    on.some((f) => f.key === 'roles') && '`/roles create` - make a panel where people pick roles',
    on.some((f) => f.key === 'alerts') && '`/alerts twitch` - post when a streamer goes live',
    on.some((f) => f.key === 'welcome') && '`/welcome test` - see what new members will see',
    on.some((f) => f.key === 'automod') && '`/automod status` - turn on spam and bad-word blocking',
    on.some((f) => f.key === 'music') && '`/radio` - play some music (join a voice channel first)',
    '`/help` - see everything I can do',
  ].filter(Boolean);
  return [
    '## 🎉 All done!',
    "Great job! Here's how I'm set up:",
    '',
    `**✅ My jobs:** ${on.length ? on.map((f) => `${f.emoji} ${f.name}`).join(', ') : 'none'}`,
    off.length ? `**⛔ Turned off:** ${off.map((f) => `${f.emoji} ${f.name}`).join(', ')}` : null,
    '',
    '### 📣 Where I post',
    ...postingLines(guild),
    '',
    '### 👉 Try these next',
    ...tips.map((tip) => `• ${tip}`),
  ]
    .filter((line) => line !== null)
    .join('\n');
}

function stepPayload(step, guild, note) {
  const index = STEPS.indexOf(step);
  const container = new ContainerBuilder().setAccentColor(SETUP_COLOR);
  container.addTextDisplayComponents(text(step === 'done' ? doneText(guild) : STEP_TEXT[step]));
  for (const part of stepControls(step, guild)) {
    if (part instanceof ActionRowBuilder) container.addActionRowComponents(part);
    else container.addTextDisplayComponents(part);
  }
  if (note) container.addTextDisplayComponents(text(note));
  container.addSeparatorComponents(new SeparatorBuilder());
  const nav = [];
  if (step === 'start') {
    nav.push(button('setup:go:jobs', "Let's go!", '▶️', ButtonStyle.Success));
  } else if (step === 'done') {
    nav.push(button('setup:go:music', 'Back', '◀️'), button('setup:go:start', 'Start over', '🔁'), button('access:view', 'Who can use what', '🔐'));
  } else {
    nav.push(button(`setup:go:${STEPS[index - 1]}`, 'Back', '◀️'), button(`setup:go:${STEPS[index + 1]}`, STEPS[index + 1] === 'done' ? 'Finish' : 'Next', STEPS[index + 1] === 'done' ? '🏁' : '▶️', ButtonStyle.Primary));
  }
  container.addActionRowComponents(row(...nav));
  return { flags: MessageFlags.IsComponentsV2, components: [container], allowedMentions: { parse: [] } };
}

// A menu pick in /setup -> saved. Returns a short "saved" note.
function applyPick(field, values, guild) {
  const id = guild.id;
  const one = values[0] ?? null;
  const list = (ids) => (ids.length ? access.mentionChannels(ids) : 'none');
  switch (field) {
    case 'jobs':
      for (const feature of access.FEATURES) access.setEnabled(id, feature.key, values.includes(feature.key));
      return `✅ Saved! I'll do ${values.length} job${values.length === 1 ? '' : 's'}.`;
    case 'logs':
      logs.setLogChannel(id, one);
      return one ? `✅ Saved! The mod log goes in <#${one}>.` : '✅ Saved! The mod log is off.';
    case 'welcome':
    case 'goodbye':
      welcome.setChannel(id, field, one);
      return one ? `✅ Saved! ${field === 'welcome' ? 'Welcome' : 'Goodbye'} messages go in <#${one}>.` : `✅ Saved! ${field === 'welcome' ? 'Welcome' : 'Goodbye'} messages are off.`;
    case 'levelups':
      leveling.setAnnounceChannel(id, one);
      return one ? `✅ Saved! Level-ups go in <#${one}>.` : "✅ Saved! I'll cheer right where people chat.";
    case 'commands':
      access.setRule(id, 'all', { channels: values });
      return `✅ Saved! My commands work in: ${values.length ? list(values) : 'every channel'}.`;
    case 'quiet':
      access.setIgnored(id, values);
      return `✅ Saved! Quiet channels: ${list(values)}.`;
    case 'linkchannels':
      access.setRule(id, 'feature:links', { channels: values });
      return `✅ Saved! I make link cards in: ${values.length ? list(values) : 'every channel'}.`;
    case 'musicroles':
    case 'levelroles':
    case 'linkroles': {
      const key = { musicroles: 'music', levelroles: 'leveling', linkroles: 'links' }[field];
      const roles = values.filter((roleId) => roleId !== id); // @everyone means everyone anyway
      access.setRule(id, `feature:${key}`, { roles });
      return `✅ Saved! ${access.targetLabel(`feature:${key}`)}: ${roles.length ? `only ${access.mentionRoles(roles)}` : 'everyone'}.`;
    }
    case 'dj':
      music.setMusicSettings(id, { djRoleId: one });
      return one ? `✅ Saved! <@&${one}> are the DJs.` : '✅ Saved! Every listener can skip and stop.';
    case 'voice':
      music.setMusicSettings(id, { voiceChannels: values });
      return `✅ Saved! I play music in: ${values.length ? list(values) : 'any voice channel'}.`;
    case 'volume':
      music.setMusicSettings(id, { volume: Number(one) });
      return `✅ Saved! Music starts at ${one}%.`;
    default:
      return null;
  }
}

async function handleComponent(interaction) {
  const [prefix, action, arg] = interaction.customId.split(':');
  if (prefix === 'access') {
    // Everyone can see who can use what; only admins see where everything gets posted.
    return interaction.reply(accessView(interaction.guild, { showPosting: isAdmin(interaction) }));
  }
  if (!isAdmin(interaction)) {
    return interaction.reply({
      content: 'Only people who can manage the server can use the setup guide. Ask an admin! You can still use `/help` to see what I can do.',
      flags: MessageFlags.Ephemeral,
    });
  }
  if (action === 'start') {
    const payload = stepPayload('start', interaction.guild);
    return interaction.reply({ ...payload, flags: payload.flags | MessageFlags.Ephemeral });
  }
  if (action === 'go' && STEPS.includes(arg)) return interaction.update(stepPayload(arg, interaction.guild));
  if (action === 'set' && STEP_OF_FIELD[arg]) {
    const note = applyPick(arg, interaction.values ?? [], interaction.guild);
    console.log(`/setup: ${by(interaction)} changed ${arg} in "${interaction.guild.name}".`);
    return interaction.update(stepPayload(STEP_OF_FIELD[arg], interaction.guild, note));
  }
}

// ---------------------------------------------------------------------------
// /access
// ---------------------------------------------------------------------------

async function accessCommand(interaction) {
  const reply = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  if (!isAdmin(interaction)) return reply('Only people with the **Manage Server** permission can use /access.');
  const guildId = interaction.guildId;
  const sub = interaction.options.getSubcommand();
  if (sub === 'view') return interaction.reply(accessView(interaction.guild, { showPosting: true }));

  if (sub === 'feature') {
    const key = interaction.options.getString('feature', true);
    const on = interaction.options.getBoolean('on', true);
    const feature = access.featureByKey.get(key);
    access.setEnabled(guildId, key, on);
    console.log(`/access: ${by(interaction)} turned ${key} ${on ? 'on' : 'off'}.`);
    const notes = {
      automod: on ? '' : '\n-# Auto-mod rules are run by Discord itself, so the ones already on keep working. Turn them off with `/automod`.',
      leveling: on ? '\n-# People now earn XP when they chat. See it with `/rank`.' : '\n-# Everyone keeps their XP for when it comes back on.',
    };
    return reply(`${on ? '✅' : '⛔'} ${feature.emoji} **${feature.name}** is ${on ? 'on' : "off. Its commands won't work, and it won't do anything by itself"}.${notes[key] ?? ''}`);
  }

  if (sub === 'quiet-channel') {
    const channel = interaction.options.getChannel('channel', true);
    const quiet = interaction.options.getBoolean('quiet', true);
    const current = access.ignoredChannels(guildId);
    access.setIgnored(guildId, quiet ? [...current, channel.id] : current.filter((id) => id !== channel.id));
    console.log(`/access: ${by(interaction)} made channel ${channel.id} ${quiet ? 'quiet' : 'not quiet'}.`);
    return reply(quiet ? `🙈 I'll stay quiet in <#${channel.id}>: no link cards, no XP, and no commands.` : `👂 I'm back on in <#${channel.id}>.`);
  }

  const target = access.parseTarget(interaction.options.getString('what', true));
  if (!target) return reply("I don't know that one. Start typing and pick a feature or command from the list.");
  const label = access.targetLabel(target);
  const rule = access.ruleFor(guildId, target);

  if (sub === 'reset') {
    access.resetRule(guildId, target);
    console.log(`/access: ${by(interaction)} reset ${target}.`);
    return reply(`✅ Everyone can use **${label}** in every channel again.`);
  }
  if (sub === 'add-role' || sub === 'remove-role') {
    const role = interaction.options.getRole('role', true);
    if (role.id === guildId) return reply('Pick a real role - **@everyone** already means everyone. To let everyone use it again, use `/access reset`.');
    const roles = sub === 'add-role' ? [...rule.roles, role.id] : rule.roles.filter((id) => id !== role.id);
    access.setRule(guildId, target, { roles });
    console.log(`/access: ${by(interaction)} ${sub === 'add-role' ? 'added' : 'removed'} role ${role.id} for ${target}.`);
    return reply(
      roles.length
        ? `✅ Now only ${access.mentionRoles(roles)} can use **${label}**.\n-# People who can manage the server always can. Add more roles the same way.`
        : `✅ Everyone can use **${label}** again.`
    );
  }
  // add-channel / remove-channel
  const channel = interaction.options.getChannel('channel', true);
  const channels = sub === 'add-channel' ? [...rule.channels, channel.id] : rule.channels.filter((id) => id !== channel.id);
  access.setRule(guildId, target, { channels });
  console.log(`/access: ${by(interaction)} ${sub === 'add-channel' ? 'added' : 'removed'} channel ${channel.id} for ${target}.`);
  return reply(
    channels.length
      ? `✅ **${label}** now only works in ${access.mentionChannels(channels)}.\n-# Add more channels the same way.`
      : `✅ **${label}** works in every channel again.`
  );
}

async function handleAutocomplete(interaction) {
  if (interaction.commandName !== ACCESS_COMMAND.name) return false;
  const typed = interaction.options.getFocused().trim().toLowerCase().replace(/^\//, '');
  const choices = access.targetChoices().filter((choice) => !typed || choice.name.toLowerCase().includes(typed) || choice.value.includes(typed));
  await interaction.respond(choices.slice(0, 25)).catch(() => {});
  return true;
}

async function handleCommand(interaction) {
  if (interaction.commandName === SETUP_COMMAND.name) {
    if (!isAdmin(interaction)) {
      await interaction.reply({ content: 'Only people with the **Manage Server** permission can use /setup.', flags: MessageFlags.Ephemeral });
      return true;
    }
    const payload = stepPayload('start', interaction.guild);
    await interaction.reply({ ...payload, flags: payload.flags | MessageFlags.Ephemeral });
    return true;
  }
  if (interaction.commandName === ACCESS_COMMAND.name) {
    await accessCommand(interaction);
    return true;
  }
  return false;
}

module.exports = {
  commands: [SETUP_COMMAND, ACCESS_COMMAND],
  handleCommand,
  handleAutocomplete,
  handleComponent,
  // For tests.
  stepPayload,
  accessView,
  STEPS,
};
