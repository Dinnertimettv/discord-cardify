// /help and !help: what Cardify can do, in plain words. A home page, a page
// per feature (what it is, how to start, its commands), and a page per
// command with every option. Command details come from the commands
// themselves, so they never go out of date.
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionsBitField,
  SeparatorBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
} = require('discord.js');
const access = require('./access');

const HELP_COLOR = 0x5865f2;
const TEXT_LIMIT = 3800;

const HELP_COMMAND = new SlashCommandBuilder()
  .setName('help')
  .setDescription('See everything I can do, and how to use it')
  .setContexts(InteractionContextType.Guild)
  .addStringOption((o) => o.setName('topic').setDescription('A feature or command to learn about').setAutocomplete(true));

// The admin tools get a page too.
const SETUP_TOPIC = { key: 'setup', emoji: '⚙️', name: 'Server setup', short: 'Set me up, and choose who can use what', commands: ['setup', 'access', 'help'] };
const TOPICS = [...access.FEATURES, SETUP_TOPIC];
const topicByKey = new Map(TOPICS.map((topic) => [topic.key, topic]));

// What each feature is, and how to get going - short and simple.
const GUIDES = {
  links: {
    about: 'Share a link and I make it look great. Posts from X, TikTok, Instagram, Twitch and YouTube turn into neat cards with pictures, and videos that play right in Discord. News links skip the paywall.',
    start: ['Paste a link in chat. I do the rest!', 'Admins can change how I post links with `/embeds`.'],
  },
  roles: {
    about: 'Let people pick their own roles - like colors, games, or which pings they want. You make a panel, people click to get a role, and click again to take it off.',
    start: ['Make a panel: `/roles create title:Pick a color style:Buttons`', 'Add a role to it: `/roles add panel:<the panel\'s link> role:@Red emoji:🔴`', 'Done! People click the panel to get their roles.'],
  },
  expressions: {
    about: 'Add new emojis and soundboard sounds without opening Server Settings.',
    start: ['Emoji: `/emoji add name:party image:<pick a picture>`', 'Sound: `/sound add name:horn file:<pick an MP3>`'],
  },
  alerts: {
    about: 'I tell everyone when a Twitch streamer goes live, or when a YouTube channel posts a new video.',
    start: ['Twitch: `/alerts twitch streamer:<name> post-in:#announcements`', 'YouTube: `/alerts youtube channel:<link or @name> post-in:#videos`', 'Add `ping:@role` to ping a role. See them all with `/alerts list`.'],
  },
  moderation: {
    about: 'Tools that help mods keep the server safe and friendly. Everything mods do goes in the mod log.',
    start: ['Warn someone: `/mod warn member:@name reason:Please be nice`', 'Give a time-out: `/mod timeout member:@name duration:10 minutes`', 'Clean up chat: `/mod purge count:20`'],
  },
  automod: {
    about: 'Discord blocks bad messages for you, all by itself - even when I\'m offline. I just set it up for you.',
    start: ['Block a word: `/automod words-add words:badword`', 'Block invite links: `/automod invites on:True`', 'See what\'s on: `/automod status`'],
  },
  logs: {
    about: 'A private channel where I write down what happens: deleted and edited messages, bans, people joining and leaving, and what mods do.',
    start: ['Make a private channel that only mods can see.', 'Then: `/logs set channel:#mod-log`'],
  },
  welcome: {
    about: 'I say hi to new members with a card that shows their picture, and goodbye when someone leaves. Add a few welcome messages and I pick a different one each time! I can give every new member a role, too.',
    start: [
      'Pick a channel: `/welcome set channel:#welcome`',
      'Add your own messages: `/welcome add-message message:Hi {user}, welcome in!`',
      'See how it looks: `/welcome test`',
      'Give new members a role: `/welcome autorole role:@Member`',
    ],
  },
  leveling: {
    about: 'People earn XP when they chat (only once a minute, so spamming doesn\'t help). More XP means a higher level! I cheer every level-up with a random message - silly jokes for the first levels, big cheers for the high ones. You can give roles as prizes, too.',
    start: [
      'Turn it on: `/levels on on:True`',
      'See your level: `/rank`',
      'Give a prize role: `/levels reward level:5 role:@Active`',
      'See the level-up messages: `/levels messages`',
      'Add your own: `/levels add-message for:Levels 1-4 text:GG {user}, level {level}!`',
    ],
  },
  music: {
    about: 'I play music in voice channels. Search for any song, or paste a YouTube or Spotify link (songs, albums and playlists work too). I can also play radio stations, songs you upload, and the sound from X, TikTok, Instagram and Twitch clips.',
    start: [
      "Join a voice channel, then open its chat (the 💬 button on the channel). Music commands work in there!",
      'Type the name of a song: `/play song:never gonna give you up`',
      'Or paste a link: `/play song:<a YouTube or Spotify link>`',
      'Play a radio station: `/radio station:lofi`',
      'Use the buttons on the card to pause, skip or stop.',
    ],
  },
  tempvoice: {
    about: 'Join a special voice channel and I make you your very own voice channel, then move you into it. You can name it, lock it, and set how many people fit. When everyone leaves, it goes away by itself!',
    start: [
      'Make the special channel: `/join-to-create create`',
      'Or use a voice channel you already have: `/join-to-create add channel:#Hang-out`',
      'Join it - I make your own channel and move you in.',
      'In your channel\'s chat, press 🔒 Lock, 🔓 Unlock or 👑 Claim.',
    ],
  },
  setup: {
    about: 'Tools for admins: set me up step by step, and choose who can use what, and where.',
    start: ['New here? Run `/setup` - it walks you through everything.', 'Choose who can use what: `/access`', 'See everything I can do: `/help` (or type `!help`)'],
  },
};

// Discord's permission names, the way the Server Settings screen says them.
const PERMISSION_NAMES = {
  ManageGuild: 'Manage Server',
  ManageRoles: 'Manage Roles',
  ModerateMembers: 'Timeout Members',
  KickMembers: 'Kick Members',
  BanMembers: 'Ban Members',
  ManageMessages: 'Manage Messages',
  ManageGuildExpressions: 'Manage Expressions',
  // The old name for the same permission.
  ManageEmojisAndStickers: 'Manage Expressions',
  CreateGuildExpressions: 'Create Expressions',
  Administrator: 'Administrator',
};

let commandsByName = new Map();

// index.js hands over every command once they're all known.
function init({ commands }) {
  commandsByName = new Map(commands.map((command) => [command.name, command.toJSON?.() ?? command]));
}

function whoCanUse(command) {
  if (!command?.default_member_permissions) return '👥 Everyone';
  const names = new PermissionsBitField(BigInt(command.default_member_permissions)).toArray().map((name) => PERMISSION_NAMES[name] ?? name.replace(/([a-z])([A-Z])/g, '$1 $2'));
  return `🔒 Needs **${[...new Set(names)].join(' or ')}**`;
}

const isLocked = (command) => Boolean(command?.default_member_permissions);
const optionList = (options = []) => options.filter((o) => o.type !== 1 && o.type !== 2).map((o) => `\`${o.name}${o.required ? '' : '?'}\``).join(' ');

// "In this server: ✅ on · only in #music · only for @DJ"
function rulesHere(guildId, target, feature) {
  const parts = [];
  if (feature && !access.isEnabled(guildId, feature)) parts.push('⛔ turned off');
  else if (feature) parts.push('✅ on');
  const rule = access.ruleFor(guildId, target);
  parts.push(rule.channels.length ? `only in ${access.mentionChannels(rule.channels)}` : 'works in every channel');
  parts.push(rule.roles.length ? `only for ${access.mentionRoles(rule.roles)}` : 'for everyone');
  return parts.join(' · ');
}

function fit(text) {
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT - 1)}…` : text;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function homeText(guildId) {
  const lines = TOPICS.map((topic) => {
    const off = topic.key !== 'setup' && guildId && !access.isEnabled(guildId, topic.key);
    return `${topic.emoji} **${topic.name}** - ${topic.short}${off ? ' *(turned off here)*' : ''}`;
  });
  return [
    "## 👋 Hi! I'm Cardify",
    "I'm a helper bot for this server. Here's what I can do:",
    '',
    ...lines,
    '',
    '**How to use me:** type `/` in the chat box, then pick one of my commands.',
    'Pick a topic below to learn more! 👇',
  ].join('\n');
}

function topicText(topic, guildId) {
  const guide = GUIDES[topic.key];
  const lines = [`## ${topic.emoji} ${topic.name}`, guide.about, '', '### 🚀 How to start', ...guide.start.map((step, i) => `${i + 1}. ${step}`), '', '### 📝 Commands'];
  for (const name of topic.commands) {
    const command = commandsByName.get(name);
    if (!command) continue;
    const subs = (command.options ?? []).filter((o) => o.type === 1);
    lines.push(`**/${name}** ${optionList(command.options)} - ${command.description}`);
    for (const sub of subs) lines.push(`› \`${sub.name}\` - ${sub.description}`);
    lines.push(`-# ${whoCanUse(command)}`);
  }
  if (guildId && topic.key !== 'setup') lines.push('', `### 🏠 In this server`, rulesHere(guildId, `feature:${topic.key}`, topic.key));
  return fit(lines.join('\n'));
}

function commandText(name, guildId) {
  const command = commandsByName.get(name);
  const topic = TOPICS.find((t) => t.commands.includes(name));
  const lines = [`## ${topic?.emoji ?? '❔'} /${name}`, command.description, `-# ${whoCanUse(command)} · part of ${topic ? `${topic.emoji} ${topic.name}` : 'Cardify'}`, ''];
  const describe = (options = []) =>
    options
      .filter((o) => o.type !== 1 && o.type !== 2)
      .map((o) => `   • \`${o.name}\`${o.required ? '' : ' *(optional)*'} - ${o.description}${o.choices?.length ? ` (${o.choices.map((c) => c.name).join(', ')})` : ''}`);
  const subs = (command.options ?? []).filter((o) => o.type === 1);
  if (subs.length) {
    for (const sub of subs) lines.push(`**/${name} ${sub.name}** - ${sub.description}`, ...describe(sub.options));
  } else {
    lines.push(`**/${name}**`, ...describe(command.options));
    if (!(command.options ?? []).length) lines.push('   Nothing to fill in - just send it.');
  }
  const examples = topic ? GUIDES[topic.key].start.filter((step) => step.includes(`/${name} `) || step.endsWith(`/${name}\``)) : [];
  if (examples.length) lines.push('', '### 💡 Examples', ...examples.map((step) => `• ${step}`));
  if (guildId && topic && topic.key !== 'setup') {
    lines.push('', '### 🏠 In this server', rulesHere(guildId, `command:${name}`, topic.key));
  }
  return fit(lines.join('\n'));
}

// The menus and buttons under every page. On a public !help message, picking
// something answers just you instead of changing the message for everyone.
function controls(view, { isPublic }) {
  const suffix = isPublic ? ':pub' : '';
  const rows = [];
  rows.push(
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`help:topic${suffix}`)
        .setPlaceholder('📚 Pick a topic...')
        .addOptions(
          TOPICS.map((topic) => ({ label: topic.name, value: topic.key, emoji: topic.emoji, description: topic.short.slice(0, 100), default: view.topic === topic.key }))
        )
    )
  );
  const topic = topicByKey.get(view.topic) ?? TOPICS.find((t) => t.commands.includes(view.command));
  if (topic) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`help:cmd${suffix}`)
          .setPlaceholder('🔎 See all the details of a command...')
          .addOptions(
            topic.commands
              .filter((name) => commandsByName.has(name))
              .map((name) => ({ label: `/${name}`, value: name, description: commandsByName.get(name).description.slice(0, 100), default: view.command === name }))
          )
      )
    );
  }
  const buttons = [];
  if (view.topic || view.command) buttons.push(new ButtonBuilder().setCustomId(`help:home${suffix}`).setStyle(ButtonStyle.Secondary).setLabel('Home').setEmoji('🏠'));
  buttons.push(
    new ButtonBuilder().setCustomId('setup:start').setStyle(ButtonStyle.Primary).setLabel('Setup guide (admins)').setEmoji('🚀'),
    new ButtonBuilder().setCustomId('access:view').setStyle(ButtonStyle.Secondary).setLabel('Who can use what').setEmoji('🔐')
  );
  rows.push(new ActionRowBuilder().addComponents(buttons));
  return rows;
}

// view: { topic } | { command } | {} (home)
function page(view, { guildId, isPublic = false } = {}) {
  const text = view.command ? commandText(view.command, guildId) : view.topic ? topicText(topicByKey.get(view.topic), guildId) : homeText(guildId);
  const container = new ContainerBuilder()
    .setAccentColor(HELP_COLOR)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(text))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('-# 🔒 = only for people with that permission · type `/help` or `!help` any time'));
  for (const row of controls(view, { isPublic })) container.addActionRowComponents(row);
  return { flags: MessageFlags.IsComponentsV2, components: [container], allowedMentions: { parse: [] } };
}

// "music", "/music", "Levels", "play" -> a view, or null. A plain word means
// the topic ("music" is the Music page); with a slash it means the command.
function findView(text) {
  const raw = (text ?? '').trim().toLowerCase();
  if (!raw) return {};
  const value = raw.replace(/^[/!]/, '');
  const topic = topicByKey.get(value) ?? TOPICS.find((t) => t.name.toLowerCase() === value || t.name.toLowerCase().split(/\W+/).includes(value));
  if (raw.startsWith('/') && commandsByName.has(value)) return { command: value };
  if (topic) return { topic: topic.key };
  return commandsByName.has(value) ? { command: value } : null;
}

// ---------------------------------------------------------------------------
// /help, !help, and the page controls
// ---------------------------------------------------------------------------

async function handleCommand(interaction) {
  if (interaction.commandName !== HELP_COMMAND.name) return false;
  const view = findView(interaction.options.getString('topic'));
  if (!view) {
    await interaction.reply({ content: "I don't know that one. Try `/help` to see everything.", flags: MessageFlags.Ephemeral });
    return true;
  }
  const payload = page(view, { guildId: interaction.guildId });
  await interaction.reply({ ...payload, flags: payload.flags | MessageFlags.Ephemeral });
  return true;
}

async function handleAutocomplete(interaction) {
  if (interaction.commandName !== HELP_COMMAND.name) return false;
  const typed = interaction.options.getFocused().trim().toLowerCase().replace(/^\//, '');
  const choices = [
    ...TOPICS.map((topic) => ({ name: `${topic.emoji} ${topic.name}`, value: topic.key })),
    ...[...commandsByName.values()].map((command) => ({ name: `/${command.name} - ${command.description}`.slice(0, 100), value: `/${command.name}` })),
  ].filter((choice) => !typed || choice.name.toLowerCase().includes(typed) || choice.value.includes(typed));
  await interaction.respond(choices.slice(0, 25)).catch(() => {});
  return true;
}

// !help, !help music, !help play
const TEXT_COMMAND = /^!help(?:\s+(.+))?$/i;

function isTextHelp(content) {
  return TEXT_COMMAND.test((content ?? '').trim());
}

async function handleText(message) {
  const view = findView((message.content.trim().match(TEXT_COMMAND) ?? [])[1]);
  if (!view) {
    await message.reply({ content: "I don't know that one. Type `!help` to see everything.", allowedMentions: { repliedUser: false } }).catch(() => {});
    return;
  }
  await message
    .reply({ ...page(view, { guildId: message.guildId, isPublic: true }), allowedMentions: { parse: [], repliedUser: false } })
    .catch((err) => console.error('!help reply failed:', err.message));
}

async function handleComponent(interaction) {
  const [, action, where] = interaction.customId.split(':');
  const isPublic = where === 'pub';
  let view;
  if (action === 'home') view = {};
  else if (action === 'topic') view = { topic: interaction.values[0] };
  else if (action === 'cmd') view = { command: interaction.values[0] };
  else return;
  if (view.topic && !topicByKey.has(view.topic)) view = {};
  if (view.command && !commandsByName.has(view.command)) view = {};
  const payload = page(view, { guildId: interaction.guildId });
  // A public !help message stays as it is; you get your own copy to click around in.
  if (isPublic) return interaction.reply({ ...payload, flags: payload.flags | MessageFlags.Ephemeral });
  return interaction.update(payload);
}

module.exports = {
  commands: [HELP_COMMAND],
  handleCommand,
  handleAutocomplete,
  handleComponent,
  handleText,
  isTextHelp,
  init,
  // For tests.
  page,
  findView,
  TOPICS,
  GUIDES,
};
