// Welcome and goodbye messages, and a role new members get automatically.
// Each welcome is picked at random from the server's own messages (or a
// built-in set), so they don't all look the same.
// Set up with /welcome; saved in data/welcome.json. Joins and leaves only
// reach the bot when the Server Members intent is on in the Developer Portal.
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

const store = createStore('welcome.json', { guilds: {} });

const WELCOME_COLOR = 0x57f287;
const GOODBYE_COLOR = 0x99aab5;
// Used when a server hasn't written its own.
const DEFAULT_WELCOMES = [
  'Welcome to **{server}**, {user}! You are member #{count}.',
  "👋 Look who just arrived - it's {user}! Welcome to **{server}**.",
  '🎉 {user} just joined the party! Make yourself at home.',
  '✨ Everyone say hi to {user}, our newest member!',
  '🚪 Knock knock - {user} is here! Welcome to **{server}**.',
  "🥳 Welcome aboard, {user}! You're member #{count}.",
];
const MAX_MESSAGES = 25;
const DEFAULT_GOODBYE = '**{name}** left the server.';
const PLACEHOLDERS = 'use {user} (mention), {name}, {server} and {count} (members)';

const channelOption = (o) =>
  o.setName('channel').setDescription('Where to post').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
const messageOption = (o) => o.setName('message').setDescription(`Custom text - ${PLACEHOLDERS}`).setMaxLength(1000);

const WELCOME_COMMAND = new SlashCommandBuilder()
  .setName('welcome')
  .setDescription('Welcome and goodbye messages, and a role for new members')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) => s.setName('set').setDescription('Welcome new members in a channel').addChannelOption(channelOption).addStringOption(messageOption))
  .addSubcommand((s) =>
    s
      .setName('add-message')
      .setDescription('Add a welcome message - I pick one at random for each new member')
      .addStringOption((o) => o.setName('message').setDescription(`The text - ${PLACEHOLDERS}`).setRequired(true).setMaxLength(1000))
  )
  .addSubcommand((s) =>
    s
      .setName('remove-message')
      .setDescription('Remove one of the welcome messages')
      .addIntegerOption((o) => o.setName('number').setDescription('Its number in /welcome messages').setRequired(true).setMinValue(1))
  )
  .addSubcommand((s) => s.setName('messages').setDescription('See the welcome messages I pick from'))
  .addSubcommand((s) => s.setName('goodbye').setDescription('Say goodbye when members leave').addChannelOption(channelOption).addStringOption(messageOption))
  .addSubcommand((s) =>
    s
      .setName('autorole')
      .setDescription('A role every new member gets (leave empty to turn it off)')
      .addRoleOption((o) => o.setName('role').setDescription('The role'))
  )
  .addSubcommand((s) =>
    s
      .setName('off')
      .setDescription('Turn welcome or goodbye messages off')
      .addStringOption((o) =>
        o.setName('which').setDescription('Which to turn off').setRequired(true).addChoices({ name: 'Welcome', value: 'welcome' }, { name: 'Goodbye', value: 'goodbye' })
      )
  )
  .addSubcommand((s) => s.setName('test').setDescription('Preview the welcome message, with you as the new member'))
  .addSubcommand((s) => s.setName('status').setDescription('See the current welcome settings'));

let membersIntentOn = () => false;

function init({ membersIntentOn: check }) {
  membersIntentOn = check;
}

function settingsFor(guildId) {
  const guilds = store.load().guilds;
  guilds[guildId] ??= { welcome: null, goodbye: null, autoroleId: null };
  return guilds[guildId];
}

function fill(template, member) {
  return template
    .replaceAll('{user}', `<@${member.id}>`)
    .replaceAll('{name}', member.displayName ?? member.user?.username ?? 'Someone')
    .replaceAll('{server}', member.guild.name)
    .replaceAll('{count}', String(member.guild.memberCount));
}

function card(text, member, color) {
  const avatar = member.displayAvatarURL?.({ extension: 'png', size: 256 }) ?? member.user?.displayAvatarURL?.({ extension: 'png', size: 256 });
  const body = new TextDisplayBuilder().setContent(text);
  const container = new ContainerBuilder().setAccentColor(color);
  if (avatar) container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(body).setThumbnailAccessory(new ThumbnailBuilder().setURL(avatar)));
  else container.addTextDisplayComponents(body);
  return container;
}

async function post(client, channelId, payload) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return false;
  await channel.send(payload);
  return true;
}

// A server's own welcome messages (older settings kept a single one).
function welcomeMessages(settings) {
  if (settings.welcome?.messages?.length) return settings.welcome.messages;
  return settings.welcome?.message ? [settings.welcome.message] : [];
}

function pickWelcome(settings) {
  const pool = welcomeMessages(settings).length ? welcomeMessages(settings) : DEFAULT_WELCOMES;
  return pool[Math.floor(Math.random() * pool.length)];
}

function welcomePayload(settings, member) {
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [card(fill(pickWelcome(settings), member), member, WELCOME_COLOR)],
    // Only the new member is pinged.
    allowedMentions: { users: [member.id] },
  };
}

// ---------------------------------------------------------------------------
// /welcome
// ---------------------------------------------------------------------------

async function handleCommand(interaction) {
  if (interaction.commandName !== WELCOME_COMMAND.name) return false;
  const reply = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await reply('Only people with the **Manage Server** permission can use /welcome.');
    return true;
  }
  const settings = settingsFor(interaction.guildId);
  const sub = interaction.options.getSubcommand();
  const intentNote = membersIntentOn()
    ? ''
    : '\n⚠️ The **Server Members Intent** is off, so I can\'t see members join or leave yet. Turn it on in the Discord Developer Portal (your app → Bot → Server Members Intent), then restart the bot.';

  if (sub === 'set' || sub === 'goodbye') {
    const picked = interaction.options.getChannel('channel', true);
    const channel = interaction.guild.channels.cache.get(picked.id) ?? picked;
    if (!channel.permissionsFor?.(interaction.guild.members.me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
      await reply(`I can't post in <#${picked.id}> - give me View Channel and Send Messages there.`);
      return true;
    }
    const key = sub === 'set' ? 'welcome' : 'goodbye';
    const message = interaction.options.getString('message');
    // A new welcome text replaces the list; leaving it out keeps the messages already there.
    settings[key] = key === 'welcome' ? { channelId: picked.id, messages: message ? [message] : welcomeMessages(settings) } : { channelId: picked.id, message };
    store.save();
    console.log(`/welcome: ${interaction.user.tag} (${interaction.user.id}) set ${key} messages to channel ${picked.id}.`);
    await reply(`${key === 'welcome' ? 'Welcome' : 'Goodbye'} messages now go to <#${picked.id}>.${key === 'welcome' ? ' Try `/welcome test` to see one.' : ''}${intentNote}`);
  } else if (sub === 'autorole') {
    const role = interaction.options.getRole('role');
    if (!role) {
      settings.autoroleId = null;
      store.save();
      await reply('New members no longer get a role automatically.');
      return true;
    }
    const problem = roleProblem(interaction.guild.roles.cache.get(role.id) ?? role, interaction.guild);
    if (problem) {
      await reply(problem);
      return true;
    }
    settings.autoroleId = role.id;
    store.save();
    console.log(`/welcome: ${interaction.user.tag} (${interaction.user.id}) set the auto-role to ${role.id}.`);
    await reply(`New members now get <@&${role.id}> automatically.${intentNote}`);
  } else if (sub === 'off') {
    const which = interaction.options.getString('which', true);
    settings[which] = null;
    store.save();
    await reply(`${which === 'welcome' ? 'Welcome' : 'Goodbye'} messages are off.`);
  } else if (sub === 'test') {
    if (!settings.welcome?.channelId) {
      await reply('Welcome messages are off - set them up with `/welcome set` first.');
      return true;
    }
    const sent = await post(interaction.client, settings.welcome.channelId, {
      ...welcomePayload(settings, interaction.member),
      allowedMentions: { parse: [] },
    }).catch(() => false);
    await reply(sent ? `Posted a preview in <#${settings.welcome.channelId}>.` : "Couldn't post the preview - check my permissions in that channel.");
  } else if (sub === 'add-message' || sub === 'remove-message' || sub === 'messages') {
    const messages = [...welcomeMessages(settings)];
    if (sub === 'add-message') {
      if (messages.length >= MAX_MESSAGES) {
        await reply(`There are already ${MAX_MESSAGES} welcome messages - remove one first with \`/welcome remove-message\`.`);
        return true;
      }
      messages.push(interaction.options.getString('message', true));
    } else if (sub === 'remove-message') {
      const number = interaction.options.getInteger('number', true);
      if (!messages[number - 1]) {
        await reply(`There's no message #${number} - see them with \`/welcome messages\`.`);
        return true;
      }
      messages.splice(number - 1, 1);
    }
    if (sub !== 'messages') {
      settings.welcome = { ...(settings.welcome ?? { channelId: null }), messages };
      delete settings.welcome.message;
      store.save();
      console.log(`/welcome: ${interaction.user.tag} (${interaction.user.id}) ran ${sub} (${messages.length} messages now).`);
    }
    const list = messages.length
      ? messages.map((text, i) => `**${i + 1}.** ${text}`).join('\n')
      : `*None yet - I use my ${DEFAULT_WELCOMES.length} built-in ones. Add your own with \`/welcome add-message\`.*`;
    const header = { 'add-message': '✅ Added!', 'remove-message': '🗑️ Removed!', messages: '' }[sub];
    const where = settings.welcome?.channelId ? '' : '\n-# Welcome messages are off - pick a channel with `/welcome set`.';
    await reply(`${header ? `${header} ` : ''}I pick one of these at random for each new member:\n${list}${where}`.slice(0, 2000));
  } else if (sub === 'status') {
    const count = welcomeMessages(settings).length;
    await reply(
      [
        `**Welcome:** ${settings.welcome?.channelId ? `on, in <#${settings.welcome.channelId}> · ${count ? `${count} message${count === 1 ? '' : 's'}` : 'built-in messages'}, picked at random` : 'off'}`,
        `**Goodbye:** ${settings.goodbye ? `on, in <#${settings.goodbye.channelId}>` : 'off'}`,
        `**Auto-role:** ${settings.autoroleId ? `<@&${settings.autoroleId}>` : 'none'}`,
        `**Server Members Intent:** ${membersIntentOn() ? 'on' : 'off - joins and leaves are not seen'}`,
      ].join('\n')
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// Members joining and leaving (index.js forwards these)
// ---------------------------------------------------------------------------

async function memberJoined(member) {
  const settings = store.load().guilds[member.guild.id];
  if (!settings || !access.isEnabled(member.guild.id, 'welcome')) return;
  if (settings.autoroleId) {
    const problem = roleProblem(member.guild.roles.cache.get(settings.autoroleId), member.guild);
    if (problem) console.error(`Auto-role in "${member.guild.name}": ${problem.replace(/\*\*/g, '')}`);
    else await member.roles.add(settings.autoroleId, 'Auto-role for new members').catch((err) => console.error('Auto-role failed:', err.message));
  }
  if (settings.welcome?.channelId) await post(member.client, settings.welcome.channelId, welcomePayload(settings, member)).catch((err) => console.error('Welcome message failed:', err.message));
}

async function memberLeft(member) {
  const settings = store.load().guilds[member.guild.id];
  if (!settings?.goodbye || !access.isEnabled(member.guild.id, 'welcome')) return;
  await post(member.client, settings.goodbye.channelId, {
    flags: MessageFlags.IsComponentsV2,
    components: [card(fill(settings.goodbye.message ?? DEFAULT_GOODBYE, member), member, GOODBYE_COLOR)],
    allowedMentions: { parse: [] },
  }).catch((err) => console.error('Goodbye message failed:', err.message));
}

// For /setup: where welcome / goodbye messages go (null turns them off).
const channelFor = (guildId, which) => store.load().guilds[guildId]?.[which]?.channelId ?? null;

function setChannel(guildId, which, channelId) {
  const settings = settingsFor(guildId);
  if (which === 'welcome') settings.welcome = channelId ? { channelId, messages: welcomeMessages(settings) } : null;
  else settings.goodbye = channelId ? { channelId, message: settings.goodbye?.message ?? null } : null;
  store.save();
}

module.exports = { commands: [WELCOME_COMMAND], handleCommand, init, memberJoined, memberLeft, channelFor, setChannel, membersIntentOn: () => membersIntentOn(), DEFAULT_WELCOMES };
