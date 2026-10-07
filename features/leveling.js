// Leveling: members earn XP for chatting (15-25 per message, at most once a
// minute, so spamming doesn't pay), level up on MEE6's curve plus 20% (with a random
// message that fits the level), and can get roles at chosen levels. /rank and /leaderboard are for everyone; admins set
// it up with /levels. Saved in data/levels.json.
const {
  ChannelType,
  ContainerBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SectionBuilder,
  SlashCommandBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
} = require('discord.js');
const { createStore } = require('../store');
const { roleProblem } = require('./roles');
const access = require('./access');

const store = createStore('levels.json', { guilds: {} });

const XP_COOLDOWN_MS = 60_000;
const LEVEL_COLOR = 0xf1c40f;
const MAX_MESSAGES = 25;

// Level-up messages come in groups by level - jokes for the first few levels,
// big celebrations for the high ones. Each level-up picks one at random from
// its group: the server's own messages, or these built-in ones.
const TIERS = [
  { key: 'rookie', from: 1, emoji: '🐣', range: 'Levels 1-4', who: 'just getting started' },
  { key: 'regular', from: 5, emoji: '😎', range: 'Levels 5-9', who: 'regulars' },
  { key: 'veteran', from: 10, emoji: '🔥', range: 'Levels 10-19', who: 'veterans' },
  { key: 'legend', from: 20, emoji: '👑', range: 'Level 20 and up', who: 'legends' },
];
const DEFAULT_LEVEL_UPS = {
  rookie: [
    '🐣 {user} hit **level {level}**! Baby steps, but steps.',
    "🍼 {user} reached **level {level}**. They grow up so fast. (They don't.)",
    '🪫 {user} is now **level {level}**. Still loading... please wait.',
    '🐌 {user} crawled all the way to **level {level}**. Slow and steady!',
    '🏅 {user} reached **level {level}**! Somebody get them a participation trophy.',
    '🎮 {user} hit **level {level}**. Tutorial almost complete.',
    '📉 {user} is **level {level}** now. The bar was on the floor, and they cleared it!',
    '🍞 {user} reached **level {level}**. Still a little undercooked, but rising.',
    '📦 {user} unlocked **level {level}**. Some assembly required.',
    "🍼 {user} hit **level {level}**. Mom says it's their turn on the server now.",
    '📝 {user} reached **level {level}**. Their résumé now lists "Discord experience."',
    '🚲 {user} is now **level {level}**. Training wheels stay on for now.',
    "🥚 {user} reached **level {level}**. Not hatched yet, but something's definitely moving in there.",
    "📶 {user} hit **level {level}**. One bar of signal, but it's connecting.",
    '👏 {user} reached **level {level}**. Somewhere, a single NPC slow-claps.',
    '🛟 {user} is **level {level}** now. The deep end is still closed to them.',
    "🎈 {user} hit **level {level}**! It's not a big deal, but we got balloons anyway.",
    '🪴 {user} reached **level {level}**. Water them with attention and they might grow.',
  ],
  regular: [
    '📈 {user} reached **level {level}**! Okay, they actually talk now.',
    "🛋️ {user} hit **level {level}**. They've basically moved in.",
    '😎 {user} is now **level {level}**. Kinda cool, not gonna lie.',
    '🍕 {user} reached **level {level}**! That earns them a slice.',
    '🎯 {user} hit **level {level}**. Regular status: unlocked.',
    '☕ {user} reached **level {level}** - powered by snacks and chatting.',
    "🪑 {user} hit **level {level}**. They have a usual seat now. Don't sit in it.",
    '🧾 {user} reached **level {level}**. At this point they should be paying rent.',
    "🔑 {user} is now **level {level}**. Here's a spare key. Please stop knocking.",
    '📬 {user} hit **level {level}**. Should we start forwarding their mail here?',
    '📱 {user} reached **level {level}**. Their screen time report is going to be brutal.',
    '🍿 {user} is **level {level}**. Shows up to every drama with snacks ready.',
    "🦜 {user} hit **level {level}**. Talks a lot. We've grown to like it.",
    '👋 {user} reached **level {level}**. Nobody says "who?" when they post anymore.',
    '🗣️ {user} is now **level {level}**. Has opinions now. So many opinions.',
    '🛁 {user} hit **level {level}**. Comfortable enough to chat in a bathrobe now.',
  ],
  veteran: [
    "🔥 {user} reached **level {level}**. They're on fire!",
    '⚔️ {user} hit **level {level}** - a battle-tested veteran of the chat.',
    '💪 {user} is now **level {level}**. Touch grass? Never heard of it.',
    '🚀 {user} just blasted off to **level {level}**!',
    '🧠 {user} reached **level {level}**. Big brain chatter energy.',
    '🏋️ {user} hit **level {level}**. Respect the grind.',
    '🌱 {user} hit **level {level}**. The grass outside has filed a missing person report.',
    '⌨️ {user} reached **level {level}**. Their keyboard has asked for a union rep.',
    '☀️ {user} is now **level {level}**. Last confirmed contact with sunlight: unknown.',
    '🧱 {user} hit **level {level}**. Basically load-bearing at this point. Do not remove.',
    '📚 {user} reached **level {level}**. Knows the lore. *All* of the lore.',
    '🔋 {user} is **level {level}**. Running on 3% battery and pure spite.',
    "🪳 {user} hit **level {level}**. Couldn't get rid of them if we tried. (We haven't tried.)",
    '🧓 {user} reached **level {level}**. Remembers this server "back in the day."',
    "🧛 {user} is now **level {level}**. Only seen after dark. Hasn't aged a day.",
    '🎓 {user} hit **level {level}**. Has a PhD in being here.',
  ],
  legend: [
    '👑 All hail {user}, now **level {level}**! A true legend of the server.',
    '🐐 {user} reached **level {level}**. The GOAT has spoken.',
    '⚡ {user} hit **level {level}**. Their power level is over 9000!',
    '🌌 {user} has ascended to **level {level}**. Mere mortals can only watch.',
    '🗿 {user} reached **level {level}**. Somebody build this person a statue.',
    "🧙 {user} is now **level {level}**. They've seen things. They know things.",
    '⏰ {user} hit **level {level}**. Said "one more message" about {level} levels ago.',
    '🏛️ {user} reached **level {level}**. Historians will study these messages.',
    '🦖 {user} is now **level {level}**. Has been here since this server was a swamp.',
    '💼 {user} hit **level {level}**. At this point they should be on the payroll.',
    '👻 {user} reached **level {level}**. Not a member anymore. They haunt this place now.',
    "🧬 {user} is **level {level}**. Scientists estimate they're 40% Discord by now.",
    '💀 {user} hit **level {level}**. "Offline" is just a rumor to them.',
    '🌍 {user} reached **level {level}**. The outside world has sent several letters. All unopened.',
    "🪦 {user} is now **level {level}**. When they go, we're naming a channel after them.",
    '🎤 {user} hit **level {level}**. *drops mic* *picks it back up* *keeps typing*',
  ],
};

const tierFor = (level) => TIERS.findLast((tier) => level >= tier.from) ?? TIERS[0];
const tierOption = (o) =>
  o
    .setName('for')
    .setDescription('Which levels it is for')
    .setRequired(true)
    .addChoices(...TIERS.map((tier) => ({ name: `${tier.range} (${tier.who})`, value: tier.key })));

const RANK_COMMAND = new SlashCommandBuilder()
  .setName('rank')
  .setDescription('See your level and XP (or someone else\'s)')
  .setContexts(InteractionContextType.Guild)
  .addUserOption((o) => o.setName('member').setDescription('Whose rank to see'));

const LEADERBOARD_COMMAND = new SlashCommandBuilder()
  .setName('leaderboard')
  .setDescription('The most active members by XP')
  .setContexts(InteractionContextType.Guild);

const LEVELS_COMMAND = new SlashCommandBuilder()
  .setName('levels')
  .setDescription('Set up leveling')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) =>
    s.setName('on').setDescription('Turn leveling on or off').addBooleanOption((o) => o.setName('on').setDescription('On or off').setRequired(true))
  )
  .addSubcommand((s) =>
    s
      .setName('channel')
      .setDescription('Where level-ups are announced (run it without a channel: where the member chats)')
      .addChannelOption((o) => o.setName('channel').setDescription('The channel').addChannelTypes(ChannelType.GuildText))
  )
  .addSubcommand((s) =>
    s
      .setName('add-message')
      .setDescription('Add a level-up message - I pick one at random for each level-up')
      .addStringOption(tierOption)
      .addStringOption((o) => o.setName('text').setDescription('The text - {user} mentions them, {level} is their new level').setRequired(true).setMaxLength(500))
  )
  .addSubcommand((s) =>
    s
      .setName('remove-message')
      .setDescription('Remove one of your level-up messages')
      .addStringOption(tierOption)
      .addIntegerOption((o) => o.setName('number').setDescription('Its number in /levels messages').setRequired(true).setMinValue(1))
  )
  .addSubcommand((s) => s.setName('messages').setDescription('See the level-up messages I pick from'))
  .addSubcommand((s) =>
    s
      .setName('test')
      .setDescription('Preview a level-up message, with you as the member (only you see it)')
      .addIntegerOption((o) => o.setName('level').setDescription('The level to pretend you reached').setRequired(true).setMinValue(1).setMaxValue(500))
  )
  .addSubcommand((s) =>
    s
      .setName('reward')
      .setDescription('Give a role when members reach a level')
      .addIntegerOption((o) => o.setName('level').setDescription('The level').setRequired(true).setMinValue(1).setMaxValue(500))
      .addRoleOption((o) => o.setName('role').setDescription('The role (run it without a role to remove this level\'s reward)'))
  )
  .addSubcommand((s) =>
    s
      .setName('reset')
      .setDescription("Reset a member's XP to zero")
      .addUserOption((o) => o.setName('member').setDescription('The member').setRequired(true))
  )
  .addSubcommand((s) => s.setName('status').setDescription('See the leveling settings'));

// How much more XP each level takes than on MEE6's curve. Saved with each
// server's members, so changing it rescales their XP and nobody loses a level.
const XP_SCALE = 1.2;

// XP needed to go from one level to the next (MEE6's curve, times XP_SCALE).
function xpForNextLevel(level, scale = XP_SCALE) {
  return Math.round(scale * (5 * level * level + 50 * level + 100));
}

// Total XP -> { level, into (XP into the current level), needed (for the next) }.
function levelFromXp(xp, scale = XP_SCALE) {
  let level = 0;
  let left = xp;
  while (left >= xpForNextLevel(level, scale)) {
    left -= xpForNextLevel(level, scale);
    level++;
  }
  return { level, into: left, needed: xpForNextLevel(level, scale) };
}

// XP on one curve -> the same level, and the same share of the way to the next, on another.
function rescaleXp(xp, from, to) {
  const { level, into, needed } = levelFromXp(xp, from);
  let total = 0;
  for (let l = 0; l < level; l++) total += xpForNextLevel(l, to);
  return total + Math.floor((into / needed) * xpForNextLevel(level, to));
}

function guildData(guildId) {
  const guilds = store.load().guilds;
  const data = (guilds[guildId] ??= { channelId: null, messages: {}, rewards: {}, users: {} });
  data.messages ??= {};
  // Members' XP was earned on an older curve: move it to this one, same levels.
  if ((data.xpScale ?? 1) !== XP_SCALE) {
    for (const user of Object.values(data.users)) user.xp = rescaleXp(user.xp, data.xpScale ?? 1, XP_SCALE);
    data.xpScale = XP_SCALE;
    store.save();
  }
  // Older settings had one custom message for every level.
  if (data.message) {
    for (const { key } of TIERS) data.messages[key] ??= [data.message];
    delete data.message;
  }
  return data;
}

function pickLevelUp(data, level) {
  const { key } = tierFor(level);
  const pool = data.messages[key]?.length ? data.messages[key] : DEFAULT_LEVEL_UPS[key];
  return pool[Math.floor(Math.random() * pool.length)];
}

const fillLevelUp = (template, userId, level) => template.replaceAll('{user}', `<@${userId}>`).replaceAll('{level}', String(level));

function progressBar(into, needed) {
  const filled = Math.round((into / needed) * 12);
  return `\`${'█'.repeat(filled)}${'░'.repeat(12 - filled)}\``;
}

// ---------------------------------------------------------------------------
// Earning XP (index.js forwards every message here)
// ---------------------------------------------------------------------------

async function onMessage(message, now = Date.now()) {
  if (!message.guildId || message.author.bot || message.webhookId || !message.member) return;
  // Off, an ignored channel, or a channel / role that /access leaves out.
  if (!access.allowsMessage(message, 'leveling')) return;
  const data = guildData(message.guildId);
  const user = (data.users[message.author.id] ??= { xp: 0, lastAt: 0 });
  if (now - user.lastAt < XP_COOLDOWN_MS) return;
  const before = levelFromXp(user.xp).level;
  user.xp += 15 + Math.floor(Math.random() * 11);
  user.lastAt = now;
  store.save();
  const after = levelFromXp(user.xp).level;
  if (after > before) await levelUp(message, data, after);
}

async function levelUp(message, data, level) {
  // Every reward at or below the new level, in case one was added later.
  for (const [rewardLevel, roleId] of Object.entries(data.rewards)) {
    if (Number(rewardLevel) > level || message.member.roles.cache.has(roleId)) continue;
    const problem = roleProblem(message.guild.roles.cache.get(roleId), message.guild);
    if (problem) console.error(`Level reward in "${message.guild.name}": ${problem.replace(/\*\*/g, '')}`);
    else await message.member.roles.add(roleId, `Reached level ${rewardLevel}`).catch((err) => console.error('Level reward failed:', err.message));
  }
  const text = fillLevelUp(pickLevelUp(data, level), message.author.id, level);
  const channel = data.channelId ? await message.client.channels.fetch(data.channelId).catch(() => null) : message.channel;
  await channel
    ?.send({ content: text, allowedMentions: { users: [message.author.id] } })
    .catch((err) => console.error('Level-up message failed:', err.message));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

// One group's messages for /levels messages: the server's own (numbered, so
// they can be removed) or the built-in ones.
function messageList(data, tier) {
  const own = data.messages[tier.key] ?? [];
  const clip = (text) => (text.length > 150 ? `${text.slice(0, 149)}…` : text);
  const lines = own.length ? own.map((text, i) => `**${i + 1}.** ${clip(text)}`) : DEFAULT_LEVEL_UPS[tier.key].map((text) => `- ${text}`);
  const header = `**${tier.emoji} ${tier.range}** (${tier.who}) · ${own.length ? 'your messages' : 'built-in - add your own with `/levels add-message`'}`;
  return [header, ...lines].join('\n');
}

function ranked(data) {
  return Object.entries(data.users)
    .filter(([, user]) => user.xp > 0)
    .sort(([, a], [, b]) => b.xp - a.xp);
}

async function showRank(interaction) {
  const data = guildData(interaction.guildId);
  if (!access.isEnabled(interaction.guildId, 'leveling')) return interaction.reply({ content: "Leveling isn't on in this server.", flags: MessageFlags.Ephemeral });
  const target = interaction.options.getUser('member') ?? interaction.user;
  const xp = data.users[target.id]?.xp ?? 0;
  const { level, into, needed } = levelFromXp(xp);
  const position = ranked(data).findIndex(([id]) => id === target.id) + 1;
  const text = [
    `### <@${target.id}>`,
    `**Level ${level}**  ·  ${position ? `rank **#${position}**` : 'unranked'}  ·  ${xp.toLocaleString()} XP total`,
    `${progressBar(into, needed)} ${into.toLocaleString()} / ${needed.toLocaleString()} XP to level ${level + 1}`,
  ].join('\n');
  const avatar = target.displayAvatarURL?.({ extension: 'png', size: 256 });
  const container = new ContainerBuilder().setAccentColor(LEVEL_COLOR);
  const body = new TextDisplayBuilder().setContent(text);
  if (avatar) container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(body).setThumbnailAccessory(new ThumbnailBuilder().setURL(avatar)));
  else container.addTextDisplayComponents(body);
  return interaction.reply({ flags: MessageFlags.IsComponentsV2, components: [container], allowedMentions: { parse: [] } });
}

async function showLeaderboard(interaction) {
  const data = guildData(interaction.guildId);
  if (!access.isEnabled(interaction.guildId, 'leveling')) return interaction.reply({ content: "Leveling isn't on in this server.", flags: MessageFlags.Ephemeral });
  const top = ranked(data).slice(0, 10);
  if (top.length === 0) return interaction.reply({ content: 'Nobody has any XP yet - start chatting!', flags: MessageFlags.Ephemeral });
  const medals = ['🥇', '🥈', '🥉'];
  const lines = top.map(([id, user], i) => `${medals[i] ?? `**${i + 1}.**`} <@${id}> - level ${levelFromXp(user.xp).level} · ${user.xp.toLocaleString()} XP`);
  const container = new ContainerBuilder()
    .setAccentColor(LEVEL_COLOR)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(['### 🏆 Leaderboard', ...lines].join('\n')));
  return interaction.reply({ flags: MessageFlags.IsComponentsV2, components: [container], allowedMentions: { parse: [] } });
}

async function configure(interaction) {
  const reply = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  // A card holds about 4,000 characters, so a long list (every group's
  // messages) goes out as more than one private card.
  const replyCard = async (...parts) => {
    const cards = [];
    for (const part of parts.map((text) => text.slice(0, 3900))) {
      if (cards.length && cards.at(-1).length + 2 + part.length <= 3900) cards[cards.length - 1] += `\n\n${part}`;
      else cards.push(part);
    }
    const card = (text) => ({
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      components: [new ContainerBuilder().setAccentColor(LEVEL_COLOR).addTextDisplayComponents(new TextDisplayBuilder().setContent(text))],
      allowedMentions: { parse: [] },
    });
    await interaction.reply(card(cards[0]));
    for (const text of cards.slice(1)) await interaction.followUp(card(text));
    return true;
  };
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return reply('Only people with the **Manage Server** permission can use /levels.');
  const data = guildData(interaction.guildId);
  const sub = interaction.options.getSubcommand();
  const by = `${interaction.user.tag} (${interaction.user.id})`;
  if (sub === 'on') {
    const on = interaction.options.getBoolean('on', true);
    access.setEnabled(interaction.guildId, 'leveling', on);
    console.log(`/levels: ${by} turned leveling ${on ? 'on' : 'off'}.`);
    return reply(on ? 'Leveling is on - members earn XP for chatting. See it with `/rank` and `/leaderboard`.' : 'Leveling is off. Everyone keeps their XP for when it comes back on.');
  }
  if (sub === 'channel') {
    const picked = interaction.options.getChannel('channel');
    data.channelId = picked?.id ?? null;
    store.save();
    return reply(picked ? `Level-ups are announced in <#${picked.id}>.` : 'Level-ups are announced wherever the member is chatting.');
  }
  if (sub === 'add-message' || sub === 'remove-message') {
    const tier = TIERS.find((t) => t.key === interaction.options.getString('for', true));
    const messages = [...(data.messages[tier.key] ?? [])];
    if (sub === 'add-message') {
      if (messages.length >= MAX_MESSAGES) return reply(`${tier.range} already has ${MAX_MESSAGES} messages - remove one first with \`/levels remove-message\`.`);
      messages.push(interaction.options.getString('text', true));
    } else {
      const number = interaction.options.getInteger('number', true);
      if (!messages[number - 1]) {
        return reply(messages.length ? `There's no message #${number} for ${tier.range} - see them with \`/levels messages\`.` : `${tier.range} uses my built-in messages - there are none of yours to remove.`);
      }
      messages.splice(number - 1, 1);
    }
    data.messages[tier.key] = messages;
    store.save();
    console.log(`/levels: ${by} ran ${sub} for ${tier.key} (${messages.length} messages now).`);
    return replyCard(`${sub === 'add-message' ? '✅ Added!' : '🗑️ Removed!'} I pick one of these at random:`, messageList(data, tier));
  }
  if (sub === 'messages') {
    return replyCard('### 🎉 Level-up messages\nEach level-up picks one at random from its group.', ...TIERS.map((tier) => messageList(data, tier)));
  }
  if (sub === 'test') {
    const level = interaction.options.getInteger('level', true);
    const tier = tierFor(level);
    return reply(`${fillLevelUp(pickLevelUp(data, level), interaction.user.id, level)}\n-# Preview from the ${tier.emoji} ${tier.range} group - only you can see this.`);
  }
  if (sub === 'reward') {
    const level = interaction.options.getInteger('level', true);
    const role = interaction.options.getRole('role');
    if (!role) {
      delete data.rewards[level];
      store.save();
      return reply(`Level ${level} no longer gives a role.`);
    }
    const problem = roleProblem(interaction.guild.roles.cache.get(role.id) ?? role, interaction.guild);
    if (problem) return reply(problem);
    data.rewards[level] = role.id;
    store.save();
    console.log(`/levels: ${by} set the level ${level} reward to role ${role.id}.`);
    return reply(`Members get <@&${role.id}> when they reach level ${level}.`);
  }
  if (sub === 'reset') {
    const target = interaction.options.getUser('member', true);
    delete data.users[target.id];
    store.save();
    console.log(`/levels: ${by} reset the XP of ${target.id}.`);
    return reply(`Reset <@${target.id}>'s XP to zero.`);
  }
  // status
  const rewards = Object.entries(data.rewards)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([level, roleId]) => `level ${level} → <@&${roleId}>`);
  return reply(
    [
      `**Leveling:** ${access.isEnabled(interaction.guildId, 'leveling') ? 'on' : 'off'}`,
      `**Level-ups announced in:** ${data.channelId ? `<#${data.channelId}>` : 'wherever the member is chatting'}`,
      `**Level-up messages** (picked at random): ${TIERS.map((t) => `${t.range}: ${data.messages[t.key]?.length ? `${data.messages[t.key].length} of yours` : 'built-in'}`).join(' · ')}`,
      `**Role rewards:** ${rewards.length ? rewards.join(', ') : 'none'}`,
      `**Members with XP:** ${ranked(data).length}`,
    ].join('\n')
  );
}

async function handleCommand(interaction) {
  if (interaction.commandName === RANK_COMMAND.name) await showRank(interaction);
  else if (interaction.commandName === LEADERBOARD_COMMAND.name) await showLeaderboard(interaction);
  else if (interaction.commandName === LEVELS_COMMAND.name) await configure(interaction);
  else return false;
  return true;
}

// Where level-ups are announced (null: wherever the member is chatting) - for /setup.
const announceChannel = (guildId) => store.load().guilds[guildId]?.channelId ?? null;

function setAnnounceChannel(guildId, channelId) {
  guildData(guildId).channelId = channelId ?? null;
  store.save();
}

module.exports = {
  commands: [RANK_COMMAND, LEADERBOARD_COMMAND, LEVELS_COMMAND],
  handleCommand,
  onMessage,
  announceChannel,
  setAnnounceChannel,
  // For tests.
  levelFromXp,
  rescaleXp,
  DEFAULT_LEVEL_UPS,
};
