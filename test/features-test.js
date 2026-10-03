// Offline tests for the server features in features/ (role panels, emoji and
// soundboard uploads), driven with fake servers, roles, members and commands.
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.BOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-features-test-'));
process.on('exit', () => fs.rmSync(process.env.BOT_DATA_DIR, { recursive: true, force: true }));

const discord = require('discord.js');
const roles = require('../features/roles');
const expressions = require('../features/expressions');
const alerts = require('../features/alerts');
const logs = require('../features/logs');
const moderation = require('../features/moderation');
const automod = require('../features/automod');
const welcome = require('../features/welcome');
const leveling = require('../features/leveling');
const music = require('../features/music');
const access = require('../features/access');
const help = require('../features/help');
const setup = require('../features/setup');

const { PermissionFlagsBits, PermissionsBitField, ComponentType, MessageFlags } = discord;
let failures = 0;

async function check(label, fn) {
  let problem;
  try {
    problem = await fn();
  } catch (err) {
    problem = `threw: ${err.stack}`;
  }
  if (problem) failures++;
  console.log(`=== ${problem ? 'FAIL' : 'ok  '} ${label}${problem ? `\n  CHECK FAILED: ${problem}` : ''}`);
}

// --- fakes ---------------------------------------------------------------------------

const json = (payload) => JSON.parse(JSON.stringify({ ...payload, components: payload.components?.map((c) => c.toJSON?.() ?? c) }));
const walk = (components) => components.flatMap((c) => [c, ...walk(c.components ?? []), ...(c.accessory ? [c.accessory] : [])]);
const textOf = (payload) => walk(payload.components).filter((c) => c.type === ComponentType.TextDisplay).map((c) => c.content).join('\n');

function makeRole(id, name, { permissions = 0n, managed = false, editable = true } = {}) {
  return { id, name, managed, editable, permissions: new PermissionsBitField(permissions) };
}

const guild = { id: 'g1', name: 'Test Server' };
guild.roles = { cache: new Map() };
for (const role of [
  makeRole('g1', '@everyone'),
  makeRole('r-gamer', 'Gamer'),
  makeRole('r-artist', 'Artist'),
  makeRole('r-red', 'Red'),
  makeRole('r-blue', 'Blue'),
  makeRole('r-mod', 'Mod', { permissions: PermissionFlagsBits.ManageMessages }),
  makeRole('r-admin', 'Admin', { permissions: PermissionFlagsBits.Administrator }),
  makeRole('r-bot', 'SomeBot', { managed: true }),
  makeRole('r-high', 'Above Cardify', { editable: false }),
]) guild.roles.cache.set(role.id, role);

function makeMember(id) {
  const has = new Set();
  const member = { id, guild, log: [] };
  member.roles = {
    cache: { has: (roleId) => has.has(roleId) },
    add: async (roleId) => { has.add(roleId); member.log.push(`+${roleId}`); },
    remove: async (roleId) => { has.delete(roleId); member.log.push(`-${roleId}`); },
  };
  return member;
}
const alex = makeMember('u-alex');
guild.members = { fetch: async () => alex };

// Every message the fake channel holds, by id.
const messages = new Map();
function makeMessage(id, payload) {
  const message = { id, url: `https://discord.com/channels/g1/c1/${id}`, payload: json(payload), reacted: [], guild, guildId: 'g1' };
  message.reactions = { cache: new Map() };
  message.edit = async (p) => { message.payload = json(p); };
  message.react = async (emoji) => {
    if (String(emoji).includes('999999999999999999')) throw new Error('Unknown Emoji');
    message.reacted.push(emoji);
    const key = roles.emojiKey(emoji);
    const removedUsers = [];
    message.reactions.cache.set(key, { removed: false, remove: async () => { message.reactions.cache.get(key).removed = true; }, users: { remove: async (u) => removedUsers.push(u) }, removedUsers });
  };
  messages.set(id, message);
  return message;
}
let nextId = 100000000000000000n;
const channel = {
  id: 'c1',
  send: async (payload) => makeMessage(String(nextId++), payload),
  messages: { fetch: async (id) => messages.get(id) },
};
guild.channels = { fetch: async () => channel };

function command(name, sub, options = {}, { canManage = true, permission } = {}) {
  const log = [];
  const interaction = {
    commandName: name, guild, guildId: 'g1', channel, channelId: 'c1', user: { id: 'u-admin', tag: 'admin#0001' },
    memberPermissions: { has: (p) => (permission ? p === permission : canManage) },
    deferred: false, replied: false, log,
    options: {
      getSubcommand: () => sub,
      getString: (n) => options[n] ?? null,
      getBoolean: (n) => options[n] ?? null,
      getInteger: (n) => options[n] ?? null,
      getRole: (n) => (options[n] ? guild.roles.cache.get(options[n]) : null),
      getAttachment: (n) => options[n] ?? null,
      getChannel: (n) => options[n] ?? null,
      getMember: (n) => (options[n]?.member ? options[n] : null),
      getUser: (n) => (options[n] ? options[n].user ?? options[n] : null),
    },
    deferReply: async (o) => { interaction.deferred = true; log.push(['deferReply', o]); },
    reply: async (p) => { interaction.replied = true; log.push(['reply', p]); },
    editReply: async (p) => { log.push(['editReply', p]); },
    deleteReply: async () => { log.push(['deleteReply']); },
    followUp: async (p) => { log.push(['followUp', p]); },
  };
  return interaction;
}
const answer = (interaction) => interaction.log.findLast((l) => ['reply', 'editReply', 'followUp'].includes(l[0]))?.[1];
const run = async (interaction) => {
  for (const feature of [roles, expressions, alerts, logs, moderation, automod, welcome, leveling, music, help, setup]) if (await feature.handleCommand(interaction)) return interaction;
  throw new Error(`no feature handled /${interaction.commandName}`);
};

function click(message, customId, member = alex) {
  const log = [];
  const interaction = { customId, message, member, guild, deferred: false, replied: false, log };
  interaction.reply = async (p) => { interaction.replied = true; log.push(['reply', p]); };
  interaction.editReply = async (p) => log.push(['editReply', p]);
  return interaction;
}

(async () => {
  console.log('----- role panels -----');
  await check('someone without Manage Roles -> refused', async () => {
    const i = await run(command('roles', 'create', { title: 'x', style: 'buttons' }, { canManage: false }));
    return answer(i).content.includes('Manage Roles') && messages.size === 0 ? null : answer(i).content;
  });

  // A buttons panel.
  const created = await run(command('roles', 'create', { title: 'Pick your games', style: 'buttons', description: 'Get pinged for what you play' }));
  const buttonsPanel = [...messages.values()].at(-1);
  await check('create -> panel posted with title, description, "no roles yet"; admin told how to add roles', async () => {
    const text = textOf(buttonsPanel.payload);
    if (!text.includes('### Pick your games') || !text.includes('Get pinged for what you play') || !text.includes('No roles yet')) return text;
    if (buttonsPanel.payload.flags !== MessageFlags.IsComponentsV2) return 'not a card message';
    return answer(created).content.includes(`/roles add panel:${buttonsPanel.id}`) ? null : answer(created).content;
  });
  await check('add a role (by message link) with an emoji -> button on the panel', async () => {
    const i = await run(command('roles', 'add', { panel: buttonsPanel.url, role: 'r-gamer', emoji: '🎮' }));
    const button = walk(buttonsPanel.payload.components).find((c) => c.custom_id === 'role:r-gamer');
    if (!answer(i).content.startsWith('Added <@&r-gamer>')) return answer(i).content;
    return button?.label === 'Gamer' && button.emoji?.name === '🎮' && textOf(buttonsPanel.payload).includes('🎮  <@&r-gamer>') ? null : JSON.stringify(button);
  });
  await run(command('roles', 'add', { panel: buttonsPanel.id, role: 'r-artist', label: 'Artists' }));
  for (const [role, why] of [['r-admin', 'moderator-level'], ['r-mod', 'moderator-level'], ['r-bot', 'belongs to a bot'], ['r-high', 'drag my role above'], ['g1', '@everyone']]) {
    await check(`add ${role} -> refused (${why})`, async () => {
      const i = await run(command('roles', 'add', { panel: buttonsPanel.id, role }));
      return answer(i).content.includes(why) && !walk(buttonsPanel.payload.components).some((c) => c.custom_id === `role:${role}`) ? null : answer(i).content;
    });
  }
  await check('not an emoji -> refused', async () => {
    const i = await run(command('roles', 'add', { panel: buttonsPanel.id, role: 'r-red', emoji: 'hello' }));
    return answer(i).content.includes("isn't an emoji") ? null : answer(i).content;
  });
  await check('click a role button -> role given; click again -> taken away', async () => {
    const first = click(buttonsPanel, 'role:r-gamer');
    await roles.handleButton(first, 'r-gamer');
    const second = click(buttonsPanel, 'role:r-gamer');
    await roles.handleButton(second, 'r-gamer');
    if (answer(first).content !== 'You now have the **Gamer** role.' || answer(first).flags !== MessageFlags.Ephemeral) return JSON.stringify(answer(first));
    return answer(second).content === 'Removed the **Gamer** role.' && alex.log.join() === '+r-gamer,-r-gamer' ? null : alex.log.join();
  });
  await check("a role whose permissions changed to moderator-level after it was added -> clicks refused", async () => {
    guild.roles.cache.get('r-artist').permissions = new PermissionsBitField(PermissionFlagsBits.BanMembers);
    const i = click(buttonsPanel, 'role:r-artist');
    await roles.handleButton(i, 'r-artist');
    guild.roles.cache.get('r-artist').permissions = new PermissionsBitField(0n);
    return answer(i).content.includes('moderator-level') && !alex.log.includes('+r-artist') ? null : answer(i).content;
  });

  // A one-at-a-time dropdown.
  alex.log.length = 0;
  await run(command('roles', 'create', { title: 'Name color', style: 'menu', 'one-only': true }));
  const menuPanel = [...messages.values()].at(-1);
  await run(command('roles', 'add', { panel: menuPanel.id, role: 'r-red', emoji: '🟥' }));
  await run(command('roles', 'add', { panel: menuPanel.id, role: 'r-blue', emoji: '<:blue:123456789012345678>' }));
  await check('dropdown panel -> one menu, pick at most 1 (one-only), with both roles and emojis', async () => {
    const menu = walk(menuPanel.payload.components).find((c) => c.custom_id === 'role-menu');
    return menu?.max_values === 1 && menu.min_values === 0 && menu.options.map((o) => `${o.value}:${o.emoji?.name}`).join() === 'r-red:🟥,r-blue:blue' ? null : JSON.stringify(menu);
  });
  await check('pick Red, then Blue from the menu -> ends with only Blue', async () => {
    const first = Object.assign(click(menuPanel, 'role-menu'), { values: ['r-red'] });
    await roles.handleSelect(first);
    const second = Object.assign(click(menuPanel, 'role-menu'), { values: ['r-blue'] });
    await roles.handleSelect(second);
    if (answer(first).content !== 'Added: **Red**') return answer(first).content;
    return answer(second).content === 'Added: **Blue**\nRemoved: **Red**' && alex.log.join() === '+r-red,-r-red,+r-blue' ? null : `${answer(second).content} | ${alex.log}`;
  });

  // A one-at-a-time reaction panel.
  alex.log.length = 0;
  await run(command('roles', 'create', { title: 'Team', style: 'reactions', 'one-only': true }));
  const reactPanel = [...messages.values()].at(-1);
  await check('reaction panel needs an emoji for each role', async () => {
    const i = await run(command('roles', 'add', { panel: reactPanel.id, role: 'r-red' }));
    return answer(i).content.includes('need an emoji') ? null : answer(i).content;
  });
  await run(command('roles', 'add', { panel: reactPanel.id, role: 'r-red', emoji: '❤️' }));
  await run(command('roles', 'add', { panel: reactPanel.id, role: 'r-blue', emoji: '💙' }));
  await check('reaction panel -> the bot reacts with each role\'s emoji', async () => (reactPanel.reacted.join() === '❤️,💙' ? null : reactPanel.reacted.join()));
  await check('an emoji from another server (Discord refuses it) -> nothing added, admin told why', async () => {
    const i = await run(command('roles', 'add', { panel: reactPanel.id, role: 'r-gamer', emoji: '<:nope:999999999999999999>' }));
    return answer(i).content.includes('has to be from this server') && !textOf(reactPanel.payload).includes('r-gamer') ? null : answer(i).content;
  });
  const reaction = (name) => ({ partial: false, emoji: { id: null, name }, message: reactPanel });
  // Start without the Blue role left over from the dropdown test.
  await alex.roles.remove('r-blue');
  alex.log.length = 0;
  await check('react ❤ (without the variation selector) -> Red; react 💙 -> Blue, Red dropped and its reaction removed; unreact 💙 -> Blue dropped', async () => {
    await roles.handleReaction(reaction('❤'), { id: 'u-alex', bot: false }, true);
    await roles.handleReaction(reaction('💙'), { id: 'u-alex', bot: false }, true);
    await roles.handleReaction(reaction('💙'), { id: 'u-alex', bot: false }, false);
    if (alex.log.join() !== '+r-red,+r-blue,-r-red,-r-blue') return alex.log.join();
    return reactPanel.reactions.cache.get('❤').removedUsers.join() === 'u-alex' ? null : 'the other reaction was not removed';
  });
  await check('reactions from bots and on other messages are ignored', async () => {
    alex.log.length = 0;
    await roles.handleReaction(reaction('💙'), { id: 'u-bot', bot: true }, true);
    await roles.handleReaction({ partial: false, emoji: { name: '💙' }, message: buttonsPanel }, { id: 'u-alex', bot: false }, true);
    return alex.log.length === 0 ? null : alex.log.join();
  });

  await check('remove a role -> gone from the panel and its reaction cleared', async () => {
    const i = await run(command('roles', 'remove', { panel: reactPanel.id, role: 'r-blue' }));
    return answer(i).content.startsWith('Removed <@&r-blue>') && !textOf(reactPanel.payload).includes('r-blue') && reactPanel.reactions.cache.get('💙').removed ? null : answer(i).content;
  });
  await check('list -> every panel with its style, role count and link', async () => {
    const text = answer(await run(command('roles', 'list'))).content;
    return text.includes('**Pick your games** - buttons, 2 role(s)') && text.includes('**Name color** - dropdown menu, 2 role(s), one at a time') && text.includes(reactPanel.id) ? null : text;
  });
  await check('panel message deleted -> panel forgotten; clicks on it say so', async () => {
    roles.forgetDeletedPanel(buttonsPanel.id);
    const i = click(buttonsPanel, 'role:r-gamer');
    await roles.handleButton(i, 'r-gamer');
    const saved = JSON.parse(fs.readFileSync(path.join(process.env.BOT_DATA_DIR, 'roles.json'), 'utf8'));
    return answer(i).content.includes("isn't set up anymore") && !saved.panels[buttonsPanel.id] && saved.panels[menuPanel.id] ? null : answer(i).content;
  });

  console.log('\n----- emoji and soundboard uploads -----');
  const created_ = [];
  guild.emojis = {
    create: async (o) => {
      if (o.name === 'full') throw Object.assign(new Error('Maximum number of emojis reached'), { code: 30008 });
      created_.push(o);
      return { id: '1', name: o.name, toString: () => `<:${o.name}:1>` };
    },
  };
  const sounds = [];
  guild.soundboardSounds = { create: async (o) => { sounds.push(o); return { name: o.name }; } };
  const image = { url: 'https://cdn.discordapp.com/attachments/1/2/cat.png', size: 50_000, contentType: 'image/png', name: 'cat.png' };

  await check('/emoji add from an uploaded image', async () => {
    const i = await run(command('emoji', 'add', { name: 'cool cat!', image }));
    return answer(i).content === 'Added <:cool_cat_:1> as `:cool_cat_:`.' && created_[0].attachment === image.url ? null : answer(i).content;
  });
  await check("/emoji add copying another server's animated emoji -> its GIF, its name", async () => {
    await run(command('emoji', 'add', { copy: '<a:partyparrot:123456789012345678>' }));
    return created_[1].attachment === 'https://cdn.discordapp.com/emojis/123456789012345678.gif' && created_[1].name === 'partyparrot' ? null : JSON.stringify(created_[1]);
  });
  for (const [label, options, expect] of [
    ['two sources at once', { name: 'x', image, link: 'https://i.imgur.com/a.png' }, 'exactly one'],
    ['no source', { name: 'x' }, 'exactly one'],
    ['an http link', { name: 'xx', link: 'http://i.imgur.com/a.png' }, 'public https link'],
    ['a link into the home network', { name: 'xx', link: 'https://192.168.1.1/a.png' }, 'public https link'],
    ['an image over 256 KB', { name: 'xx', image: { ...image, size: 300_000 } }, 'over 256 KB'],
    ['a non-image file', { name: 'xx', image: { ...image, contentType: 'application/pdf' } }, "isn't an image"],
    ['a one-letter name', { name: 'x', image }, 'name'],
    ['a server out of emoji slots', { name: 'full', image }, 'no free emoji slots'],
  ]) {
    await check(`/emoji add with ${label} -> refused`, async () => {
      const i = await run(command('emoji', 'add', options));
      return answer(i).content.includes(expect) ? null : answer(i).content;
    });
  }
  await check('/emoji without permission -> refused', async () => {
    const i = await run(command('emoji', 'add', { name: 'xx', image }, { canManage: false }));
    return answer(i).content.includes("Only people who can manage") ? null : answer(i).content;
  });
  await check('/emoji with only "Create Expressions" -> allowed', async () => {
    const i = await run(command('emoji', 'add', { name: 'okay', image }, { permission: PermissionFlagsBits.CreateGuildExpressions }));
    return answer(i).content.startsWith('Added') ? null : answer(i).content;
  });

  const mp3 = { url: 'https://cdn.discordapp.com/attachments/1/2/bruh.mp3', size: 80_000, contentType: 'audio/mpeg', name: 'bruh.mp3' };
  await check('/sound add an MP3 at 50% volume with an emoji', async () => {
    const i = await run(command('sound', 'add', { name: 'bruh', file: mp3, emoji: '💀', volume: 50 }));
    const [sound] = sounds;
    return answer(i).content === 'Added **bruh** to the soundboard.' && sound.file === mp3.url && sound.volume === 0.5 && sound.emojiName === '💀' && sound.contentType === 'audio/mpeg' ? null : JSON.stringify(sound);
  });
  await check('/sound add with a custom emoji -> sent as its id', async () => {
    await run(command('sound', 'add', { name: 'yay', file: { ...mp3, contentType: 'audio/ogg', name: 'yay.ogg' }, emoji: '<:yay:123456789012345678>' }));
    return sounds[1].emojiId === '123456789012345678' && sounds[1].contentType === 'audio/ogg' && sounds[1].volume === 1 ? null : JSON.stringify(sounds[1]);
  });
  for (const [label, file, expect] of [
    ['a WAV file', { ...mp3, contentType: 'audio/wav', name: 'a.wav' }, 'MP3 or OGG'],
    ['a file over 512 KB', { ...mp3, size: 600_000 }, 'over 512 KB'],
  ]) {
    await check(`/sound add with ${label} -> refused`, async () => {
      const i = await run(command('sound', 'add', { name: 'nope', file }));
      return answer(i).content.includes(expect) && sounds.length === 2 ? null : answer(i).content;
    });
  }

  console.log('\n----- Twitch and YouTube alerts -----');
  const twitchUsers = {
    shroud: { login: 'shroud', displayName: 'shroud', stream: null },
    pokimane: { login: 'pokimane', displayName: 'Pokimane', stream: { createdAt: '2026-10-01T10:00:00Z', title: 'already live' } },
  };
  const feeds = {
    UCrick000000000000000000: [
      { id: 'oldvideo001', title: 'Old one', published: Date.now() - 5 * 86400000 },
      { id: 'oldvideo002', title: 'Older one', published: Date.now() - 9 * 86400000 },
    ],
  };
  const feedXml = (id) =>
    `<feed><author><name>Rick Astley</name></author>${feeds[id]
      .map((v) => `<entry><yt:videoId>${v.id}</yt:videoId><title>${v.title}</title><link rel="alternate" href="https://www.youtube.com/${v.short ? 'shorts/' : 'watch?v='}${v.id}"/><published>${new Date(v.published).toISOString()}</published></entry>`)
      .join('')}</feed>`;
  const alertChannel = { id: 'c-alerts', sent: [], permissionsFor: () => ({ has: () => true }), send: async (p) => alertChannel.sent.push(json(p)) };
  const lockedChannel = { id: 'c-locked', permissionsFor: () => ({ has: () => false }) };
  guild.channels.cache = new Map([['c-alerts', alertChannel], ['c-locked', lockedChannel]]);
  guild.members.me = {};
  guild.roles.cache.set('r-notify', makeRole('r-notify', 'Notifications'));
  alerts.setDependencies({
    client: { channels: { fetch: async (id) => guild.channels.cache.get(id) } },
    isAllowedServer: () => true,
    decodeHtmlEntities: (s) => s.replace(/&amp;/g, '&'),
    request: async (url) => {
      if (url === 'https://www.youtube.com/@RickAstleyYT') {
        return new Response('<link rel="canonical" href="https://www.youtube.com/channel/UCrick000000000000000000"><meta property="og:title" content="Rick Astley">');
      }
      const feedId = url.match(/channel_id=(\w+)/)?.[1];
      if (feedId && feeds[feedId]) return new Response(feedXml(feedId));
      return new Response('not found', { status: 404 });
    },
    fetchTwitch: async (kind, login) => {
      if (!twitchUsers[login]) throw new Error('not found');
      return structuredClone(twitchUsers[login]);
    },
    twitchUrl: (kind, login) => `https://www.twitch.tv/${login}`,
    buildTwitchCard: (kind, user) => ({ toJSON: () => ({ type: ComponentType.Container, components: [{ type: ComponentType.TextDisplay, content: `[twitch card ${user.login} ${user.stream?.title}]` }] }) }),
    youtubeUrl: (kind, id) => (kind === 'short' ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`),
    fetchYouTube: async (id) => ({ title: `Title of ${id}` }),
    buildYouTubeCard: (video, link) => ({ toJSON: () => ({ type: ComponentType.Container, components: [{ type: ComponentType.TextDisplay, content: `[youtube card ${link.url}]` }] }) }),
  });

  await check('/alerts without Manage Server -> refused', async () => {
    const i = await run(command('alerts', 'list', {}, { canManage: false }));
    return answer(i).content.includes('Manage Server') ? null : answer(i).content;
  });
  await check('/alerts twitch for a streamer that does not exist -> says so', async () => {
    const i = await run(command('alerts', 'twitch', { streamer: 'nobody_here_123', 'post-in': alertChannel }));
    return answer(i).content.includes("can't find that Twitch streamer") ? null : answer(i).content;
  });
  await check("/alerts twitch into a channel the bot can't post in -> refused", async () => {
    const i = await run(command('alerts', 'twitch', { streamer: 'shroud', 'post-in': lockedChannel }));
    return answer(i).content.includes("I can't post in <#c-locked>") ? null : answer(i).content;
  });
  await check('/alerts twitch by channel link, pinging a role -> added', async () => {
    const i = await run(command('alerts', 'twitch', { streamer: 'https://www.twitch.tv/Shroud', 'post-in': alertChannel, ping: 'r-notify' }));
    return answer(i).content === "Added: I'll post in <#c-alerts> when **shroud** goes live." ? null : answer(i).content;
  });
  await check('streamer offline -> nothing posted; goes live -> card with the role ping; same stream again -> no repost', async () => {
    await alerts.checkTwitch();
    if (alertChannel.sent.length) return 'posted while offline';
    twitchUsers.shroud.stream = { createdAt: '2026-10-03T12:00:00Z', title: 'ranked grind' };
    await alerts.checkTwitch();
    await alerts.checkTwitch();
    const [sent] = alertChannel.sent;
    if (alertChannel.sent.length !== 1) return `${alertChannel.sent.length} posts`;
    if (textOf(sent) !== '🔴 **shroud** is live!\n<@&r-notify>\n[twitch card shroud ranked grind]') return textOf(sent);
    const button = walk(sent.components).find((c) => c.type === ComponentType.Button);
    return sent.allowedMentions.roles.join() === 'r-notify' && button?.url === 'https://www.twitch.tv/shroud' ? null : JSON.stringify(sent.allowedMentions);
  });
  await check('next stream -> a new alert', async () => {
    twitchUsers.shroud.stream = { createdAt: '2026-10-04T12:00:00Z', title: 'day two' };
    await alerts.checkTwitch();
    return alertChannel.sent.length === 2 ? null : `${alertChannel.sent.length} posts`;
  });
  await check("adding a streamer who's live right now -> that stream isn't announced, the next one is", async () => {
    const i = await run(command('alerts', 'twitch', { streamer: 'pokimane', 'post-in': alertChannel, message: '@everyone {name} is on: {title}' }));
    await alerts.checkTwitch();
    if (!answer(i).content.includes("they're live now") || alertChannel.sent.length !== 2) return answer(i).content;
    twitchUsers.pokimane.stream = { createdAt: '2026-10-05T12:00:00Z', title: 'new stream' };
    await alerts.checkTwitch();
    const sent = alertChannel.sent[2];
    return textOf(sent).startsWith('@everyone Pokimane is on: new stream') && sent.allowedMentions.parse.join() === 'everyone' ? null : textOf(sent);
  });
  await check('/alerts youtube by @handle -> found, existing uploads not announced', async () => {
    const i = await run(command('alerts', 'youtube', { channel: 'https://www.youtube.com/@RickAstleyYT', 'post-in': alertChannel }));
    await alerts.checkYouTube();
    return answer(i).content === "Added: I'll post in <#c-alerts> when **Rick Astley** uploads." && alertChannel.sent.length === 3 ? null : answer(i).content;
  });
  await check('new upload -> announced with its card; a newly listed but old video -> skipped', async () => {
    feeds.UCrick000000000000000000.unshift({ id: 'newvideo001', title: 'Never &amp; Again', published: Date.now() - 60000, short: true });
    feeds.UCrick000000000000000000.push({ id: 'ancient0001', title: 'Ancient', published: Date.now() - 30 * 86400000 });
    await alerts.checkYouTube();
    await alerts.checkYouTube();
    const sent = alertChannel.sent[3];
    if (alertChannel.sent.length !== 4) return `${alertChannel.sent.length} posts`;
    return textOf(sent) === '▶️ **Rick Astley** posted a new video: **Title of newvideo001**\n[youtube card https://www.youtube.com/shorts/newvideo001]' ? null : textOf(sent);
  });
  await check('/alerts list -> numbered, with platform, name, channel and ping', async () => {
    const text = answer(await run(command('alerts', 'list'))).content;
    return text.includes('**1.** 🔴 Twitch - **shroud** → <#c-alerts> (pings <@&r-notify>)') && text.includes('**3.** ▶️ YouTube - **Rick Astley** → <#c-alerts>') ? null : text;
  });
  await check('/alerts remove 1 -> that alert stops', async () => {
    const i = await run(command('alerts', 'remove', { number: 1 }));
    twitchUsers.shroud.stream = { createdAt: '2026-10-06T12:00:00Z', title: 'after removal' };
    await alerts.checkTwitch();
    return answer(i).content.includes('Stopped the Twitch alert for **shroud**') && alertChannel.sent.length === 4 ? null : answer(i).content;
  });
  await check('Twitch names from links are cleaned up', async () =>
    ([alerts.twitchLoginFrom('https://twitch.tv/Name_1/videos'), alerts.twitchLoginFrom('name_1'), alerts.twitchLoginFrom('bad name')].join() === 'name_1,name_1,' ? null : 'wrong'));

  console.log('\n----- mod log -----');
  const modLog = { id: 'c-modlog', sent: [], permissionsFor: () => ({ has: () => true }), send: async (p) => modLog.sent.push(json(p)) };
  guild.channels.cache.set('c-modlog', modLog);
  logs.init({ channels: { fetch: async (id) => guild.channels.cache.get(id) } });
  const lastLog = () => textOf(modLog.sent.at(-1));

  await check('/logs set without Manage Server -> refused', async () => {
    const i = await run(command('logs', 'set', { channel: modLog }, { canManage: false }));
    return answer(i).content.includes('Manage Server') ? null : answer(i).content;
  });
  await check('/logs set -> saved, confirmed, and a first entry posted', async () => {
    const i = await run(command('logs', 'set', { channel: modLog }));
    return answer(i).content.startsWith('The mod log now goes to <#c-modlog>') && lastLog().startsWith('📋 **Mod log turned on** by <@u-admin>.') ? null : answer(i).content;
  });
  const sentMessage = (id, content, extra = {}) => ({ id, guildId: 'g1', channelId: 'c1', content, partial: false, author: { id: 'u-alex', bot: false }, attachments: new Map(), url: `https://discord.com/channels/g1/c1/${id}`, ...extra });
  await check('a deleted message -> logged with who sent it and its text', async () => {
    await logs.messageDeleted(sentMessage('m1', 'oops wrong channel'));
    return lastLog().startsWith('🗑️ **Message deleted** in <#c1> · sent by <@u-alex>\n> oops wrong channel') ? null : lastLog();
  });
  await check("messages Cardify deletes itself (link reposts), bots' messages, and unknown old messages -> not logged", async () => {
    const before = modLog.sent.length;
    logs.ignoreDeletion('m2');
    await logs.messageDeleted(sentMessage('m2', 'https://x.com/a/status/1'));
    await logs.messageDeleted(sentMessage('m3', 'beep', { author: { id: 'bot', bot: true } }));
    await logs.messageDeleted(sentMessage('m4', null, { partial: true }));
    return modLog.sent.length === before ? null : lastLog();
  });
  await check('an edited message -> before and after; a link preview loading in (same text) -> not logged', async () => {
    await logs.messageEdited(sentMessage('m5', 'teh plan'), sentMessage('m5', 'the plan'));
    const edited = lastLog();
    const before = modLog.sent.length;
    await logs.messageEdited(sentMessage('m5', 'the plan'), sentMessage('m5', 'the plan'));
    return edited.includes('**Before**\n> teh plan\n**After**\n> the plan') && modLog.sent.length === before ? null : edited;
  });

  console.log('\n----- /mod -----');
  const position = (n) => ({ highest: { position: n } });
  const makeTarget = (id, name, { rolePosition = 1, timedOut = false } = {}) => {
    const actions = [];
    const target = {
      id, user: { id, tag: `${name}#0001`, send: async (p) => actions.push(`dm: ${p.content}`) },
      roles: position(rolePosition), moderatable: true, kickable: true, bannable: true, actions,
      isCommunicationDisabled: () => timedOut,
      timeout: async (ms, why) => actions.push(`timeout ${ms} (${why})`),
      kick: async (why) => actions.push(`kick (${why})`),
    };
    target.member = target;
    return target;
  };
  const bans = [];
  guild.ownerId = 'u-owner';
  guild.members.ban = async (id, o) => bans.push({ id, ...o });
  guild.members.unban = async (id) => bans.push({ unban: id });
  guild.bans = { fetch: async (id) => (id === 'u-banned' ? { user: { id } } : Promise.reject(new Error('Unknown Ban'))) };
  const modCommand = (sub, options, { perms = 'all', modPosition = 5 } = {}) => {
    const i = command('mod', sub, options);
    i.memberPermissions = { has: (p) => perms === 'all' || perms.includes(p) };
    i.member = { roles: position(modPosition) };
    i.client = { user: { id: 'u-cardify' } };
    return i;
  };
  const sam = makeTarget('u-sam', 'sam');
  await check('/mod warn -> saved as warning #1, member DMed, mod log entry', async () => {
    const i = await run(modCommand('warn', { member: sam, reason: 'spamming memes' }));
    if (answer(i).content !== 'Warned <@u-sam> - that\'s warning #1.') return answer(i).content;
    return sam.actions.join() === 'dm: ⚠️ You were warned in **Test Server**: spamming memes' && lastLog().startsWith('⚠️ <@u-admin> **warned** <@u-sam> (warning #1)\n> spamming memes') ? null : sam.actions.join();
  });
  await run(modCommand('warn', { member: sam, reason: 'again' }));
  await check('/mod warnings -> both warnings listed', async () => {
    const text = answer(await run(modCommand('warnings', { member: sam }))).content;
    return text.startsWith('<@u-sam> has 2 warning(s):') && text.includes('by <@u-admin>: spamming memes') && text.includes('by <@u-admin>: again') ? null : text;
  });
  await check('/mod clear-warnings -> cleared and logged', async () => {
    const text = answer(await run(modCommand('clear-warnings', { member: sam }))).content;
    const after = answer(await run(modCommand('warnings', { member: sam }))).content;
    return text === 'Cleared 2 warning(s) of <@u-sam>.' && after === '<@u-sam> has no warnings.' ? null : `${text} | ${after}`;
  });
  await check('/mod timeout 10 minutes -> timed out with the reason, DMed, logged', async () => {
    sam.actions.length = 0;
    const i = await run(modCommand('timeout', { member: sam, duration: '10m', reason: 'cool off' }));
    return answer(i).content === 'Timed out <@u-sam> for 10 minutes.' && sam.actions[0] === 'timeout 600000 (admin#0001: cool off)' && lastLog().includes('**timed out** <@u-sam> for 10 minutes') ? null : sam.actions.join();
  });
  for (const [label, sub, options, opts, expect] of [
    ['without Kick Members', 'kick', { member: sam }, { perms: [PermissionFlagsBits.ModerateMembers] }, 'You need the **Kick Members** permission'],
    ['on someone with a higher role', 'kick', { member: makeTarget('u-boss', 'boss', { rolePosition: 9 }) }, {}, 'same or a higher role than you'],
    ['on the server owner', 'ban', { member: makeTarget('u-owner', 'owner') }, {}, 'Nobody can ban the server owner'],
    ['on yourself', 'timeout', { member: makeTarget('u-admin', 'me'), duration: '60s' }, {}, "You can't time out yourself"],
    ['on Cardify', 'kick', { member: makeTarget('u-cardify', 'cardify') }, {}, "I can't kick myself"],
    ['when Cardify\'s role is too low', 'kick', { member: { ...makeTarget('u-x', 'x'), kickable: false, get member() { return this; } } }, {}, 'my role needs to be above theirs'],
    ['untimeout on someone not timed out', 'untimeout', { member: makeTarget('u-y', 'y') }, {}, "isn't timed out"],
    ['unban on someone not banned', 'unban', { member: { id: 'u-nobody' } }, {}, "isn't banned"],
  ]) {
    await check(`/mod ${sub} ${label} -> refused`, async () => {
      const i = await run(modCommand(sub, options, opts));
      return answer(i).content.includes(expect) ? null : answer(i).content;
    });
  }
  await check('/mod kick -> DMed first, then kicked, logged', async () => {
    const kim = makeTarget('u-kim', 'kim');
    const i = await run(modCommand('kick', { member: kim, reason: 'rule 3' }));
    return answer(i).content === 'Kicked <@u-kim>.' && kim.actions.join() === 'dm: 👢 You were kicked from **Test Server**: rule 3,kick (admin#0001: rule 3)' ? null : kim.actions.join();
  });
  await check('/mod ban someone not in the server (by ID), deleting 2 days of messages', async () => {
    const i = await run(modCommand('ban', { member: { id: 'u-raider' }, reason: 'raid', 'delete-days': 2 }));
    const [ban] = bans;
    return answer(i).content === 'Banned <@u-raider> and deleted their messages from the last 2 day(s).' && ban.deleteMessageSeconds === 172800 && ban.reason === 'admin#0001: raid' ? null : JSON.stringify(ban);
  });
  await check('/mod unban -> unbanned', async () => {
    const i = await run(modCommand('unban', { member: { id: 'u-banned' } }));
    return answer(i).content.startsWith('Unbanned <@u-banned>') && bans[1].unban === 'u-banned' ? null : answer(i).content;
  });
  await check('ban events -> in the mod log with the reason', async () => {
    await logs.memberBanned({ guild, user: { id: 'u-raider', tag: 'raider#0001' }, reason: 'admin#0001: raid' });
    return lastLog().startsWith('🔨 <@u-raider> (raider#0001) **was banned**\n> admin#0001: raid') ? null : lastLog();
  });
  await check('/mod purge 50 messages from one member -> only theirs, pins kept, their deletions not logged one by one', async () => {
    const fetched = new Map([
      ['p1', { id: 'p1', author: { id: 'u-sam' }, pinned: false }],
      ['p2', { id: 'p2', author: { id: 'u-alex' }, pinned: false }],
      ['p3', { id: 'p3', author: { id: 'u-sam' }, pinned: true }],
      ['p4', { id: 'p4', author: { id: 'u-sam' }, pinned: false }],
    ]);
    fetched.filter = function (fn) { return Object.assign(new Map([...this].filter(([, v]) => fn(v))), { filter: this.filter }); };
    let bulk = null;
    channel.messages.fetch = async (arg) => (typeof arg === 'object' ? fetched : messages.get(arg));
    channel.bulkDelete = async (doomed) => { bulk = [...doomed.keys()]; return doomed; };
    const i = await run(modCommand('purge', { count: 50, member: sam }));
    const before = modLog.sent.length;
    await logs.messageDeleted(sentMessage('p1', 'gone'));
    return answer(i).content === 'Deleted 2 message(s).' && bulk.join() === 'p1,p4' && modLog.sent.length === before ? null : `${answer(i).content} ${bulk}`;
  });

  console.log('\n----- /automod -----');
  const rules = new Map();
  guild.autoModerationRules = {
    fetch: async () => Object.assign(new Map(rules), { find(fn) { return [...this.values()].find(fn); } }),
    create: async (data) => {
      const rule = { id: `rule${rules.size}`, ...structuredClone(data), edits: 0 };
      rule.edit = async (changes) => { Object.assign(rule, structuredClone(changes)); rule.edits++; return rule; };
      rules.set(rule.id, rule);
      return rule;
    },
  };
  const ruleNamed = (name) => [...rules.values()].find((r) => r.name === name);
  await check('/automod words-add -> a Discord AutoMod keyword rule that blocks and reports to the mod log', async () => {
    const i = await run(command('automod', 'words-add', { words: 'Badword, *slur*, badword' }));
    const rule = ruleNamed('Cardify · Blocked words');
    if (answer(i).content !== 'Blocking 2 word(s) now.') return answer(i).content;
    if (rule.triggerType !== 1 || rule.eventType !== 1 || rule.triggerMetadata.keywordFilter.join() !== 'badword,*slur*') return JSON.stringify(rule);
    return rule.actions.map((a) => `${a.type}:${a.metadata.channel ?? a.metadata.customMessage}`).join() === "1:That message was blocked by this server's word filter.,2:c-modlog" ? null : JSON.stringify(rule.actions);
  });
  await check('/automod words-add again -> same rule, words merged; words-remove -> removed', async () => {
    await run(command('automod', 'words-add', { words: 'third' }));
    await run(command('automod', 'words-remove', { words: 'badword' }));
    const rule = ruleNamed('Cardify · Blocked words');
    return rules.size === 1 && rule.triggerMetadata.keywordFilter.join() === '*slur*,third' ? null : JSON.stringify(rule.triggerMetadata);
  });
  await check('/automod words-list -> spoilered list', async () => {
    const text = answer(await run(command('automod', 'words-list'))).content;
    return text === 'Blocked (2): ||*slur*||, ||third||' ? null : text;
  });
  await check('/automod invites, spam, mentions 5, profanity -> the matching Discord rule types', async () => {
    await run(command('automod', 'invites', { on: true }));
    await run(command('automod', 'spam', { on: true }));
    await run(command('automod', 'mentions', { limit: 5 }));
    await run(command('automod', 'profanity', { on: true }));
    const invites = ruleNamed('Cardify · Invite links');
    const mentions = ruleNamed('Cardify · Mass mentions');
    const profanity = ruleNamed('Cardify · Profanity & slurs');
    if (!invites.triggerMetadata.regexPatterns[0].startsWith('discord(?:')) return JSON.stringify(invites.triggerMetadata);
    if (ruleNamed('Cardify · Spam').triggerType !== 3 || mentions.triggerType !== 5 || mentions.triggerMetadata.mentionTotalLimit !== 5) return 'spam/mentions wrong';
    return profanity.triggerType === 4 && profanity.triggerMetadata.presets.join() === '1,3,2' ? null : JSON.stringify(profanity.triggerMetadata);
  });
  await check('/automod spam off -> the rule is disabled, not deleted', async () => {
    await run(command('automod', 'spam', { on: false }));
    const spam = ruleNamed('Cardify · Spam');
    return spam && spam.enabled === false ? null : JSON.stringify(spam);
  });
  await check('/automod status -> each rule on or off', async () => {
    const text = answer(await run(command('automod', 'status'))).content;
    return text.includes('🟢 **Blocked words** (2 words)') && text.includes('⚫ **Spam** - off') && text.includes('🟢 **Mass mentions** (max 5)') && text.includes('<#c-modlog>') ? null : text;
  });
  await check("Discord refusing (missing permission) -> explained", async () => {
    const saved = guild.autoModerationRules.create;
    guild.autoModerationRules.fetch = async () => Object.assign(new Map(), { find: () => undefined });
    guild.autoModerationRules.create = async () => { throw Object.assign(new Error('Missing Permissions'), { code: 50013 }); };
    const i = await run(command('automod', 'invites', { on: true }));
    guild.autoModerationRules.create = saved;
    return answer(i).content.includes('Manage Server') ? null : answer(i).content;
  });

  console.log('\n----- welcome -----');
  const welcomeChannel = { id: 'c-welcome', sent: [], permissionsFor: () => ({ has: () => true }), send: async (p) => welcomeChannel.sent.push(json(p)) };
  guild.channels.cache.set('c-welcome', welcomeChannel);
  guild.memberCount = 42;
  const lastWelcome = () => welcomeChannel.sent.at(-1);
  const fakeClient = { channels: { fetch: async (id) => guild.channels.cache.get(id) } };
  const newcomer = Object.assign(makeMember('u-new'), {
    displayName: 'Newbie',
    client: fakeClient,
    displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/u-new/a.png',
  });
  let intentOn = false;
  welcome.init({ membersIntentOn: () => intentOn });
  await check('/welcome without Manage Server -> refused', async () => {
    const i = await run(command('welcome', 'set', { channel: welcomeChannel }, { canManage: false }));
    return answer(i).content.includes('Manage Server') ? null : answer(i).content;
  });
  await check('/welcome set with the intent off -> saved, with a warning about the intent', async () => {
    const text = answer(await run(command('welcome', 'set', { channel: welcomeChannel }))).content;
    return text.startsWith('Welcome messages now go to <#c-welcome>') && text.includes('Server Members Intent') ? null : text;
  });
  await check('a member joins -> welcome card with the placeholders filled, only they are pinged', async () => {
    intentOn = true;
    await welcome.memberJoined(newcomer);
    const sent = lastWelcome();
    const text = textOf(sent);
    if (text !== 'Welcome to **Test Server**, <@u-new>! You are member #42.') return text;
    if (!walk(sent.components).some((c) => c.type === ComponentType.Thumbnail)) return 'no avatar';
    return sent.allowedMentions.users.join() === 'u-new' && sent.flags === MessageFlags.IsComponentsV2 ? null : JSON.stringify(sent.allowedMentions);
  });
  await check('/welcome autorole with a moderator role -> refused', async () => {
    const text = answer(await run(command('welcome', 'autorole', { role: 'r-mod' }))).content;
    return text.includes('moderator') ? null : text;
  });
  await check('/welcome autorole Gamer -> new members get it', async () => {
    await run(command('welcome', 'autorole', { role: 'r-gamer' }));
    const member = Object.assign(makeMember('u-new2'), { displayName: 'Two', client: fakeClient });
    await welcome.memberJoined(member);
    return member.log.join() === '+r-gamer' ? null : member.log.join();
  });
  await check('/welcome goodbye with custom text -> posted when someone leaves, nobody pinged', async () => {
    await run(command('welcome', 'goodbye', { channel: welcomeChannel, message: 'Bye {name} from {server}, {user}' }));
    await welcome.memberLeft(newcomer);
    const sent = lastWelcome();
    return textOf(sent) === 'Bye Newbie from Test Server, <@u-new>' && sent.allowedMentions.parse.length === 0 ? null : textOf(sent);
  });
  await check('/welcome test -> a preview that pings nobody', async () => {
    const before = welcomeChannel.sent.length;
    const i = command('welcome', 'test');
    i.client = fakeClient;
    i.member = newcomer;
    await run(i);
    const sent = lastWelcome();
    return welcomeChannel.sent.length === before + 1 && sent.allowedMentions.parse.length === 0 && answer(i).content.includes('Posted a preview') ? null : answer(i).content;
  });
  await check('/welcome off welcome -> no more welcome messages; status shows it', async () => {
    await run(command('welcome', 'off', { which: 'welcome' }));
    const before = welcomeChannel.sent.length;
    await welcome.memberJoined(Object.assign(makeMember('u-new3'), { displayName: 'Three', client: fakeClient }));
    const text = answer(await run(command('welcome', 'status'))).content;
    return welcomeChannel.sent.length === before && text.includes('**Welcome:** off') && text.includes('**Goodbye:** on, in <#c-welcome>') && text.includes('<@&r-gamer>') ? null : text;
  });

  console.log('\n----- leveling -----');
  const chat = [];
  const chatChannel = { id: 'c-chat', send: async (p) => chat.push(p) };
  let clock = 1_000_000;
  const chatter = makeMember('u-chatter');
  const chatMessage = (member, extra = {}) => ({ guildId: 'g1', guild, member, author: { id: member.id, bot: false }, channel: chatChannel, client: fakeClient, ...extra });
  const say = (member = chatter) => leveling.onMessage(chatMessage(member), (clock += 61_000));
  const rankText = async (id) => textOf(json(answer(await run(command('rank', null, id ? { member: { id } } : {})))));
  await check('the level curve matches MEE6 (100, 255, 475 XP)', async () => {
    const levels = [99, 100, 254, 255, 475].map((xp) => leveling.levelFromXp(xp).level).join();
    return levels === '0,1,1,2,3' ? null : levels;
  });
  await check('leveling off (the default) -> /rank says so', async () => {
    await say();
    const text = answer(await run(command('rank', null))).content;
    return text.includes("isn't on") ? null : text;
  });
  await check('/levels without Manage Server -> refused', async () => {
    const text = answer(await run(command('levels', 'on', { on: true }, { canManage: false }))).content;
    return text.includes('Manage Server') ? null : text;
  });
  await check('/levels on, reward at level 2 -> level-ups announced where they chat, the role given', async () => {
    await run(command('levels', 'on', { on: true }));
    await run(command('levels', 'reward', { level: 2, role: 'r-artist' }));
    for (let n = 0; n < 20; n++) await say();
    const ups = chat.map((p) => p.content);
    if (!ups[0]?.startsWith('🎉 <@u-chatter> reached **level 1**')) return ups.join(' | ');
    if (!ups.some((t) => t.includes('level 2'))) return ups.join(' | ');
    return chatter.log.join() === '+r-artist' && chat.every((p) => p.allowedMentions.users.join() === 'u-chatter') ? null : chatter.log.join();
  });
  await check('two messages within a minute -> only the first earns XP', async () => {
    const fast = makeMember('u-fast');
    clock += 61_000;
    await leveling.onMessage(chatMessage(fast), clock);
    await leveling.onMessage(chatMessage(fast), clock + 30_000);
    const text = await rankText('u-fast');
    const xp = Number(text.match(/([\d,]+) XP total/)[1]);
    return xp >= 15 && xp <= 25 ? null : text;
  });
  await check('bots and webhooks earn nothing', async () => {
    await leveling.onMessage(chatMessage({ id: 'u-bot' }, { author: { id: 'u-bot', bot: true } }), (clock += 61_000));
    await leveling.onMessage(chatMessage({ id: 'u-hook' }, { webhookId: 'w1' }), (clock += 61_000));
    const texts = [await rankText('u-bot'), await rankText('u-hook')];
    return texts.every((t) => t.includes('unranked') && t.includes(' 0 XP total')) ? null : texts.join(' | ');
  });
  await check('/rank -> level, rank, progress bar, avatar', async () => {
    const i = command('rank', null);
    i.user.displayAvatarURL = () => 'https://cdn.discordapp.com/avatars/u-admin/a.png';
    const payload = json(answer(await run(i)));
    const text = textOf(payload);
    return text.includes('**Level 0**') && text.includes('unranked') && text.includes('`░░░░░░░░░░░░`') && walk(payload.components).some((c) => c.type === ComponentType.Thumbnail) ? null : text;
  });
  await check('/leaderboard -> members by XP, nobody pinged', async () => {
    const payload = answer(await run(command('leaderboard', null)));
    const text = textOf(json(payload));
    return text.includes('🥇 <@u-chatter> - level') && text.includes('🥈 <@u-fast>') && payload.allowedMentions.parse.length === 0 ? null : text;
  });
  await check('/levels channel and message -> announced there with the custom text', async () => {
    const levelChannel = { id: 'c-levels', sent: [], send: async (p) => levelChannel.sent.push(p) };
    guild.channels.cache.set('c-levels', levelChannel);
    await run(command('levels', 'channel', { channel: levelChannel }));
    await run(command('levels', 'message', { text: 'GG {user}, you hit {level}!' }));
    const newbie = makeMember('u-newbie');
    for (let n = 0; n < 7; n++) await say(newbie);
    return levelChannel.sent[0]?.content === 'GG <@u-newbie>, you hit 1!' ? null : JSON.stringify(levelChannel.sent);
  });
  await check('/levels reset -> their XP is gone; /levels status lists the settings', async () => {
    await run(command('levels', 'reset', { member: { id: 'u-chatter' } }));
    const text = answer(await run(command('levels', 'status'))).content;
    return text.includes('**Leveling:** on') && text.includes('<#c-levels>') && text.includes('level 2 → <@&r-artist>') && text.includes('**Members with XP:** 2') ? null : text;
  });

  console.log('\n----- music -----');
  // A fake voice engine: connections, a player and audio that "play" instantly.
  const { EventEmitter } = require('events');
  const joins = [];
  const players = [];
  music.engine.join = (vc) => {
    joins.push(vc.id);
    const connection = new EventEmitter();
    connection.state = { status: 'ready' };
    connection.subscribe = () => {};
    connection.destroy = () => {
      const before = connection.state;
      connection.state = { status: 'destroyed' };
      connection.emit('stateChange', before, connection.state);
    };
    return connection;
  };
  music.engine.ready = async () => {};
  music.engine.createPlayer = () => {
    const player = new EventEmitter();
    player.state = { status: 'idle' };
    player.played = [];
    const to = (next) => {
      const before = player.state;
      player.state = next;
      player.emit('stateChange', before, next);
    };
    player.play = (resource) => { player.played.push(resource.metadata.title); to({ status: 'playing', resource }); };
    player.stop = () => { if (player.state.status !== 'idle') to({ status: 'idle' }); return true; };
    player.pause = () => { to({ ...player.state, status: 'paused' }); return true; };
    player.unpause = () => { to({ ...player.state, status: 'playing' }); return true; };
    player.finish = (ms) => { player.state.resource.playbackDuration = ms; to({ status: 'idle' }); };
    players.push(player);
    return player;
  };
  const resources = [];
  music.engine.createResource = (track, volume) => {
    const resource = { metadata: track, playbackDuration: 0, volume: { value: volume / 100, setVolume(v) { this.value = v; } } };
    resources.push(resource);
    return { resource, stop: () => {} };
  };
  const addresses = { 'music.example': '93.184.216.34', 'radio.example': '93.184.216.35', 'home.example': '192.168.1.20' };
  music.engine.lookup = async (host) => (addresses[host] ? [{ address: addresses[host] }] : []);
  const station = { stationuuid: 'abc-123', name: 'Chill Beats FM', url_resolved: 'https://radio.example/chill', countrycode: 'US', codec: 'MP3', bitrate: 128, homepage: 'https://radio.example/' };
  const web = {
    'https://music.example/My_Song.mp3': { type: 'audio/mpeg' },
    'https://music.example/page': { type: 'text/html; charset=utf-8' },
    'https://music.example/list.m3u': { type: 'audio/x-mpegurl', body: '#EXTM3U\n#EXTINF:-1,Live\nhttps://radio.example/live\n' },
  };
  const fakeResponse = (url, { type = 'application/json', body = '', data, status = 200 } = {}) => ({
    ok: status < 400, status, url, headers: new Headers({ 'content-type': type }),
    text: async () => body, json: async () => data, body: { cancel: async () => {} },
  });
  const musicClient = { user: { id: 'u-cardify' }, channels: { fetch: async (id) => (id === 'c1' ? channel : guild.channels.cache.get(id)) } };
  music.init({
    client: musicClient,
    request: async (url) => {
      if (url.includes('radio-browser.info/json/stations')) return fakeResponse(url, { data: [station] });
      if (url.includes('radio-browser.info/json/url')) return fakeResponse(url, { data: {} });
      return web[url] ? fakeResponse(url, web[url]) : fakeResponse(url, { status: 404 });
    },
    clipAudioFor: async (link) =>
      link.includes('/status/1') ? { url: 'https://video.example/clip.mp4', title: '@someone: a funny clip', link } : null,
  });

  const listener = (id) => ({ id, user: { bot: false } });
  const vc = { id: 'v1', type: discord.ChannelType.GuildVoice, guild, joinable: true, permissionsFor: () => ({ has: () => true }) };
  vc.members = new discord.Collection([['u-admin', listener('u-admin')], ['u-dj', listener('u-dj')], ['u-fan', listener('u-fan')]]);
  guild.channels.cache.set('v1', vc);
  const inVoice = (id, roleIds = []) => ({ id, voice: { channel: vc, channelId: 'v1' }, roles: { cache: new Set(roleIds) } });
  const musicCommand = (name, sub, options = {}, { user = 'u-admin', canManage = true, voice = true, roleIds = [] } = {}) => {
    const i = command(name, sub, options, { canManage });
    i.user = { id: user, tag: `${user}#0001` };
    i.member = voice ? inVoice(user, roleIds) : { id: user, voice: { channel: null, channelId: null }, roles: { cache: new Set() } };
    return i;
  };
  const sent = () => [...messages.values()];
  const cardText = (m) => (m.payload.components ? textOf(m.payload) : m.payload.content ?? '');
  const lastSent = () => sent().at(-1);
  const session = () => music.sessions.get('g1');
  const player = () => players.at(-1);
  const replyText = (i) => {
    const last = answer(i);
    return last?.content ?? textOf(json(last));
  };
  const buttonIds = (payload) => walk(payload.components).filter((c) => c.type === ComponentType.Button).map((c) => c.custom_id);

  await check('/play while not in a voice channel -> asked to join one', async () => {
    const text = replyText(await run(musicCommand('play', null, { link: 'https://music.example/My_Song.mp3' }, { voice: false })));
    return text.includes('Join a voice channel') && joins.length === 0 ? null : text;
  });
  await check('/play with nothing -> asks for a link or file', async () => {
    const text = replyText(await run(musicCommand('play', null, {})));
    return text.includes('`link` or a `file`') ? null : text;
  });
  for (const [label, link, expected] of [
    ['a YouTube link', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', "can't play YouTube or Spotify"],
    ['a Spotify link', 'https://open.spotify.com/track/abc', "can't play YouTube or Spotify"],
    ['a link into the home network', 'http://home.example/song.mp3', 'public websites'],
    ['a localhost link', 'http://127.0.0.1:8080/song.mp3', 'public websites'],
    ['a web page', 'https://music.example/page', 'web page, not audio'],
    ['a broken link', 'https://music.example/missing.mp3', 'error 404'],
    ['an X post without a video', 'https://x.com/someone/status/2', 'no video to play'],
    ['a Twitch channel', 'https://www.twitch.tv/somestreamer', 'only play Twitch clips'],
  ]) {
    await check(`/play ${label} -> refused privately, nothing joined`, async () => {
      const i = await run(musicCommand('play', null, { link }));
      const last = i.log.at(-1);
      const deleted = i.log.some((l) => l[0] === 'deleteReply');
      return last[0] === 'followUp' && last[1].content.includes(expected) && last[1].flags === MessageFlags.Ephemeral && deleted && joins.length === 0 ? null : JSON.stringify(i.log);
    });
  }
  await check('/play an mp3 link -> joins the voice channel, plays it, posts the Now playing card', async () => {
    const i = await run(musicCommand('play', null, { link: 'https://music.example/My_Song.mp3' }));
    const text = replyText(i);
    if (!text.startsWith('▶️ <@u-admin> started **[My Song](https://music.example/My_Song.mp3)** in <#v1>')) return text;
    if (joins.join() !== 'v1' || player().played.join() !== 'My Song' || resources.at(-1).volume.value !== 0.6) return `${joins} ${player()?.played} ${resources.at(-1)?.volume.value}`;
    await new Promise((r) => setImmediate(r));
    const card = lastSent().payload;
    const cardText = textOf(card);
    return cardText.includes('### 🎶 Now playing') && cardText.includes('added by <@u-admin>') && buttonIds(card).join() === 'music:pause,music:skip,music:stop,music:queue' && card.allowedMentions.parse.length === 0
      ? null
      : cardText;
  });
  await check('/play a .m3u playlist -> queued as its stream; the card shows what is next', async () => {
    const text = replyText(await run(musicCommand('play', null, { link: 'https://music.example/list.m3u' })));
    const track = session().queue[0];
    await new Promise((r) => setImmediate(r));
    const cardText = textOf(session().nowPlaying.message.payload);
    return text.includes('#1 in the queue') && track.url === 'https://radio.example/live' && track.live && cardText.includes('Up next: list') ? null : `${text} | ${JSON.stringify(track)} | ${cardText}`;
  });
  await check('/play an uploaded file and an X clip -> both queued', async () => {
    await run(musicCommand('play', null, { file: { url: 'https://cdn.discordapp.com/attachments/1/2/Cool_Beat.ogg', name: 'Cool_Beat.ogg', contentType: 'audio/ogg' } }, { user: 'u-fan', canManage: false }));
    await run(musicCommand('play', null, { link: 'https://x.com/someone/status/1' }));
    const titles = session().queue.map((t) => `${t.kind}:${t.title}`).join(' | ');
    return titles === 'link:list | file:Cool Beat | clip:@someone: a funny clip' ? null : titles;
  });
  await check('/play an image file -> refused', async () => {
    const i = await run(musicCommand('play', null, { file: { url: 'https://cdn.discordapp.com/x.png', name: 'x.png', contentType: 'image/png' } }));
    return i.log.at(-1)[1].content.includes("isn't audio") ? null : JSON.stringify(i.log);
  });
  await check('/music queue -> now playing and the numbered queue, privately', async () => {
    const payload = answer(await run(musicCommand('music', 'queue')));
    const text = textOf(json(payload));
    return text.includes('**Now:** [My Song]') && text.includes('**2.** Cool Beat - <@u-fan>') && text.includes('**3.** [@someone: a funny clip]') && (payload.flags & MessageFlags.Ephemeral) ? null : text;
  });
  await check('/music-setup dj-role without Manage Server -> refused', async () => {
    const text = replyText(await run(musicCommand('music-setup', 'dj-role', { role: 'r-artist' }, { canManage: false })));
    return text.includes('Manage Server') ? null : text;
  });
  await check("with a DJ role: a listener can't skip someone else's song, but can skip their own and remove their own", async () => {
    await run(musicCommand('music-setup', 'dj-role', { role: 'r-artist' }));
    const refused = replyText(await run(musicCommand('music', 'skip', {}, { user: 'u-fan', canManage: false })));
    if (!refused.includes('Only members with <@&r-artist>')) return refused;
    const removed = replyText(await run(musicCommand('music', 'remove', { position: 2 }, { user: 'u-fan', canManage: false })));
    if (!removed.includes('removed **Cool Beat**')) return removed;
    const djSkip = replyText(await run(musicCommand('music', 'skip', {}, { user: 'u-dj', canManage: false, roleIds: ['r-artist'] })));
    return djSkip.includes('skipped **[My Song]') && session().current.title === 'list' ? null : djSkip;
  });
  await check('a skip -> the old card becomes a "Played" line without buttons, a new card is posted', async () => {
    await new Promise((r) => setImmediate(r));
    const cards = sent().filter((m) => m.payload.components?.[0]?.type === ComponentType.Container && cardText(m).includes('My Song'));
    const old = cards.find((m) => cardText(m).includes('Played'));
    return old && buttonIds(old.payload).length === 0 && textOf(session().nowPlaying.message.payload).includes('### 🎶 Now playing') ? null : cards.map(cardText).join(' | ');
  });
  await check('someone outside the voice channel -> told to join it', async () => {
    const text = replyText(await run(musicCommand('music', 'pause', {}, { user: 'u-other', canManage: false, voice: false })));
    return text.includes('Join <#v1>') ? null : text;
  });
  await check('⏸️ on the card -> paused, the card shows Resume; ▶️ -> playing again', async () => {
    const message = session().nowPlaying.message;
    const clickButton = async (customId) => {
      const log = [];
      const i = { customId, guildId: 'g1', guild, message, user: { id: 'u-admin' }, member: inVoice('u-admin'), memberPermissions: { has: () => true }, log };
      i.update = async (p) => log.push(['update', json(p)]);
      i.reply = async (p) => log.push(['reply', p]);
      await music.handleButton(i, customId.split(':')[1]);
      return log.at(-1);
    };
    const paused = await clickButton('music:pause');
    if (paused[0] !== 'update' || !textOf(paused[1]).includes('### 🎶 Paused')) return JSON.stringify(paused);
    if (player().state.status !== 'paused') return player().state.status;
    const resumed = await clickButton('music:pause');
    return resumed[0] === 'update' && textOf(resumed[1]).includes('Now playing') && player().state.status === 'playing' ? null : JSON.stringify(resumed);
  });
  await check('a button on an old card -> "this player has finished"', async () => {
    const old = sent().find((m) => cardText(m).includes('Played'));
    const log = [];
    const i = { customId: 'music:skip', guildId: 'g1', guild, message: old, user: { id: 'u-admin' }, member: inVoice('u-admin'), memberPermissions: { has: () => true } };
    i.reply = async (p) => log.push(p);
    await music.handleButton(i, 'skip');
    return log[0]?.content.includes('finished') ? null : JSON.stringify(log);
  });
  await check('/music volume 30 -> the playing audio turns down', async () => {
    const text = replyText(await run(musicCommand('music', 'volume', { percent: 30 })));
    return text.includes('30%') && resources.at(-1).volume.value === 0.3 ? null : `${text} ${resources.at(-1).volume.value}`;
  });
  await check('a song that gives no audio -> "couldn\'t play" and the next one starts', async () => {
    player().finish(200);
    await new Promise((r) => setImmediate(r));
    const warning = sent().find((m) => m.payload.content?.includes("Couldn't play **list**"));
    return warning && session().current.kind === 'clip' ? null : sent().map((m) => m.payload.content).filter(Boolean).join(' | ');
  });
  await check('/music loop track -> the song plays again when it ends', async () => {
    await run(musicCommand('music', 'loop', { mode: 'track' }));
    player().finish(60_000);
    const again = session().current?.kind === 'clip' && player().played.filter((t) => t.startsWith('@someone')).length === 2;
    await run(musicCommand('music', 'loop', { mode: 'off' }));
    return again ? null : player().played.join(' | ');
  });
  await check('everyone leaves the voice channel -> paused, and playing again when someone comes back', async () => {
    const everyone = vc.members;
    vc.members = new discord.Collection([['u-cardify', { id: 'u-cardify', user: { bot: true } }]]);
    music.voiceStateChanged({ channelId: 'v1', id: 'u-admin', guild }, { channelId: null, id: 'u-admin', guild });
    const pausedAlone = player().state.status === 'paused' && session().timers.alone;
    vc.members = everyone;
    music.voiceStateChanged({ channelId: null, id: 'u-fan', guild }, { channelId: 'v1', id: 'u-fan', guild });
    return pausedAlone && player().state.status === 'playing' && !session().timers.alone ? null : `${player().state.status} ${Boolean(session().timers.alone)}`;
  });
  await check('the queue runs out -> waits to leave (unless 24/7 is on)', async () => {
    player().finish(60_000);
    return session().current === null && session().timers.idle ? null : `${session().current?.title} ${Boolean(session().timers.idle)}`;
  });
  await check('/radio -> plays the station; suggestions come from the radio directory', async () => {
    const text = replyText(await run(musicCommand('radio', null, { station: 'uuid:abc-123' })));
    const suggestions = [];
    await music.handleAutocomplete({ commandName: 'radio', options: { getFocused: () => 'chill' }, respond: async (s) => suggestions.push(...s) });
    const current = session().current;
    return text.includes('started **[Chill Beats FM](https://radio.example/)**') && current.kind === 'radio' && current.url === 'https://radio.example/chill' && !session().timers.idle &&
      suggestions[0]?.name === 'Chill Beats FM (US · MP3 128k)' && suggestions[0].value === 'uuid:abc-123'
      ? null
      : `${text} | ${JSON.stringify(suggestions)}`;
  });
  await check('/music-setup voice-channel and queue-limit -> enforced; status lists everything', async () => {
    await run(musicCommand('music-setup', 'queue-limit', { songs: 1 }));
    await run(musicCommand('play', null, { link: 'https://music.example/My_Song.mp3' }));
    const full = replyText(await run(musicCommand('play', null, { link: 'https://music.example/My_Song.mp3' })));
    if (!full.includes('queue is full (1 songs)')) return full;
    const limited = replyText(await run(musicCommand('music-setup', 'voice-channel', { channel: { id: 'v2' }, allowed: true })));
    const elsewhere = replyText(await run(musicCommand('play', null, { link: 'https://music.example/My_Song.mp3' })));
    if (!limited.includes('I can play music in: <#v2>') || !elsewhere.includes('I can only play music in <#v2>')) return `${limited} | ${elsewhere}`;
    await run(musicCommand('music-setup', 'voice-channel', { channel: { id: 'v2' }, allowed: false }));
    const status = replyText(await run(musicCommand('music-setup', 'status')));
    return status.includes('**DJ role:** <@&r-artist>') && status.includes('**Queue limit:** 1 songs') && status.includes('**Voice channels:** any') && status.includes('in <#v1>, playing [Chill Beats FM]') ? null : status;
  });
  await check('/music stop -> leaves, clears everything, the card loses its buttons', async () => {
    const card = session().nowPlaying.message;
    const text = replyText(await run(musicCommand('music', 'stop')));
    const after = replyText(await run(musicCommand('music', 'queue')));
    return text.includes('stopped the music') && !music.sessions.has('g1') && buttonIds(card.payload).length === 0 && after.includes("I'm not playing anything") ? null : `${text} | ${after}`;
  });

  console.log('\n----- /access -----');
  const asMember = (name, { roleIds = [], canManage = false, channelId = 'c1', channelObj } = {}) => {
    const i = command(name, null, {}, { canManage });
    i.member = { roles: { cache: new Map(roleIds.map((id) => [id, {}])) } };
    i.channelId = channelId;
    i.channel = channelObj ?? { id: channelId, isThread: () => false };
    return i;
  };
  await check('a new server: every feature on except Levels; nothing blocked', async () => {
    const offByDefault = access.FEATURES.filter((f) => !access.isEnabled('g-new', f.key)).map((f) => f.key).join();
    return offByDefault === 'leveling' && access.commandProblem(asMember('play')) === null ? null : offByDefault;
  });
  await check('/access without Manage Server -> refused', async () => {
    const text = answer(await run(command('access', 'view', {}, { canManage: false }))).content;
    return text.includes('Manage Server') ? null : text;
  });
  await check('/access add-role music @Artist -> only Artists (and admins) can use /play', async () => {
    const text = answer(await run(command('access', 'add-role', { what: 'feature:music', role: 'r-artist' }))).content;
    if (!text.startsWith('✅ Now only <@&r-artist> can use **🎵 Music**')) return text;
    const without = access.commandProblem(asMember('play'));
    const withRole = access.commandProblem(asMember('play', { roleIds: ['r-artist'] }));
    const admin = access.commandProblem(asMember('play', { canManage: true }));
    return without === 'Only <@&r-artist> can use **🎵 Music**.' && withRole === null && admin === null ? null : `${without} | ${withRole} | ${admin}`;
  });
  await check('/access add-channel /play #music -> /play only works there (and in its threads)', async () => {
    const text = answer(await run(command('access', 'add-channel', { what: '/play', channel: { id: 'c-music' } }))).content;
    if (!text.startsWith('✅ **/play** now only works in <#c-music>')) return text;
    const elsewhere = access.commandProblem(asMember('play', { roleIds: ['r-artist'] }));
    const there = access.commandProblem(asMember('play', { roleIds: ['r-artist'], channelId: 'c-music' }));
    const thread = access.commandProblem(asMember('play', { roleIds: ['r-artist'], channelId: 't1', channelObj: { id: 't1', isThread: () => true, parentId: 'c-music' } }));
    const radio = access.commandProblem(asMember('radio', { roleIds: ['r-artist'] }));
    return elsewhere === 'You can use /play in <#c-music>.' && there === null && thread === null && radio === null ? null : `${elsewhere} | ${there} | ${thread} | ${radio}`;
  });
  await check('/access quiet-channel -> nothing works there except /help, /setup and /access', async () => {
    const text = answer(await run(command('access', 'quiet-channel', { channel: { id: 'c-quiet' }, quiet: true }))).content;
    const blocked = access.commandProblem(asMember('rank', { canManage: true, channelId: 'c-quiet' }));
    const helpOk = access.commandProblem(asMember('help', { channelId: 'c-quiet' }));
    const message = { guildId: 'g1', channelId: 'c-quiet', channel: { id: 'c-quiet' }, member: { roles: { cache: new Map() } } };
    return text.startsWith("🙈 I'll stay quiet in <#c-quiet>") && blocked?.includes('switched off in this channel') && helpOk === null && !access.allowsMessage(message, 'links') ? null : `${text} | ${blocked}`;
  });
  await check('/access feature music off -> its commands stop, but /music-setup still works; on again', async () => {
    const text = answer(await run(command('access', 'feature', { feature: 'music', on: false }))).content;
    const play = access.commandProblem(asMember('play', { canManage: true, channelId: 'c-music' }));
    const settings = access.commandProblem(asMember('music-setup', { canManage: true }));
    await run(command('access', 'feature', { feature: 'music', on: true }));
    return text.startsWith('⛔ 🎵 **Music** is off') && play?.includes('is turned off in this server') && settings === null && access.isEnabled('g1', 'music') ? null : `${text} | ${play} | ${settings}`;
  });
  await check('/access feature automod off -> explains the Discord rules keep running', async () => {
    const text = answer(await run(command('access', 'feature', { feature: 'automod', on: false }))).content;
    await run(command('access', 'feature', { feature: 'automod', on: true }));
    return text.includes('run by Discord itself') ? null : text;
  });
  await check('/access add-role with @everyone, or an unknown thing -> explained', async () => {
    const everyone = answer(await run(command('access', 'add-role', { what: 'music', role: 'g1' }))).content;
    const unknown = answer(await run(command('access', 'add-role', { what: 'pizza', role: 'r-red' }))).content;
    return everyone.includes('@everyone') && unknown.includes("I don't know that one") ? null : `${everyone} | ${unknown}`;
  });
  await check('link cards limited to a role -> other people\'s links are left alone', async () => {
    await run(command('access', 'add-role', { what: 'links', role: 'r-red' }));
    const message = (roles) => ({ guildId: 'g1', channelId: 'c1', channel: { id: 'c1' }, member: { roles: { cache: new Map(roles.map((r) => [r, {}])) } } });
    const result = [access.allowsMessage(message([]), 'links'), access.allowsMessage(message(['r-red']), 'links')].join();
    await run(command('access', 'reset', { what: 'links' }));
    return result === 'false,true' && access.allowsMessage(message([]), 'links') ? null : result;
  });
  await check('/access remove-role and reset -> everyone again', async () => {
    const removed = answer(await run(command('access', 'remove-role', { what: 'feature:music', role: 'r-artist' }))).content;
    const reset = answer(await run(command('access', 'reset', { what: '/play' }))).content;
    return removed === '✅ Everyone can use **🎵 Music** again.' && reset.includes('every channel again') && access.commandProblem(asMember('play')) === null ? null : `${removed} | ${reset}`;
  });
  await check('/access what suggestions -> features and commands, filtered by what you type', async () => {
    const choices = [];
    await setup.handleAutocomplete({ commandName: 'access', options: { getFocused: () => 'mus' }, respond: async (c) => choices.push(...c) });
    return choices.map((c) => c.value).join() === 'feature:music,command:music,command:music-setup' ? null : JSON.stringify(choices);
  });
  await check('/access view -> every feature, the quiet channels, and where I post', async () => {
    await run(command('access', 'add-role', { what: 'command:rank', role: 'r-gamer' }));
    const payload = answer(await run(command('access', 'view')));
    const text = textOf(json(payload));
    const needed = ['**🙈 Quiet channels** (I ignore them): <#c-quiet>', '✅ ⭐ **Levels** - every channel · everyone', '↳ `/rank` - every channel · only <@&r-gamer>', '### 📣 Where I post', '📋 **Mod log:** <#c-modlog>'];
    return needed.every((n) => text.includes(n)) && payload.flags & MessageFlags.Ephemeral ? null : text;
  });

  console.log('\n----- /help and !help -----');
  const allCommands = [
    new discord.SlashCommandBuilder().setName('embeds').setDescription('Settings for how this bot fixes shared links').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    ...[roles, expressions, alerts, logs, moderation, automod, welcome, leveling, music, help, setup].flatMap((f) => f.commands),
  ];
  help.init({ commands: allCommands });
  const helpCommand = (topic) => command('help', null, topic ? { topic } : {}, { canManage: false });
  const componentCount = (payload) => walk(json(payload).components).length;
  await check('every command belongs to a help topic, and every topic has a guide', async () => {
    const covered = new Set(help.TOPICS.flatMap((t) => t.commands));
    const missing = allCommands.map((c) => c.name).filter((name) => !covered.has(name));
    const noGuide = help.TOPICS.filter((t) => !help.GUIDES[t.key]).map((t) => t.key);
    return missing.length || noGuide.length ? `missing: ${missing} / no guide: ${noGuide}` : null;
  });
  await check('/help -> a private home page with every topic, a topic menu, and setup buttons', async () => {
    const payload = answer(await run(helpCommand()));
    const text = textOf(json(payload));
    const menu = walk(json(payload).components).find((c) => c.custom_id === 'help:topic');
    const buttons = walk(json(payload).components).filter((c) => c.type === ComponentType.Button).map((c) => c.custom_id).join();
    return text.includes("## 👋 Hi! I'm Cardify") && help.TOPICS.every((t) => text.includes(t.name)) && menu?.options.length === help.TOPICS.length && buttons === 'setup:start,access:view' && payload.flags & MessageFlags.Ephemeral
      ? null
      : `${buttons} ${text}`;
  });
  await check('/help topic:music -> what it is, how to start, every command with who can use it', async () => {
    const text = textOf(json(answer(await run(helpCommand('music')))));
    const needed = ['## 🎵 Music', '### 🚀 How to start', '**/play** `link?` `file?`', '› `volume` - Set the volume', '**/music-setup**', '🔒 Needs **Manage Server**', '👥 Everyone', '### 🏠 In this server'];
    return needed.every((n) => text.includes(n)) ? null : text;
  });
  await check('/help topic:/mod -> every subcommand and option spelled out', async () => {
    const text = textOf(json(answer(await run(helpCommand('/mod')))));
    return text.includes('## 🛡️ /mod') && text.includes('**/mod ban**') && text.includes('`member`') && text.includes('*(optional)*') && text.includes('### 💡 Examples') ? null : text;
  });
  await check('/help with something unknown -> says so', async () => {
    const text = answer(await run(helpCommand('pizza'))).content;
    return text.includes("I don't know that one") ? null : text;
  });
  await check('every help page fits in one message (text and component limits)', async () => {
    const views = [{}, ...help.TOPICS.map((t) => ({ topic: t.key })), ...allCommands.map((c) => ({ command: c.name }))];
    const tooBig = views.filter((view) => {
      const payload = help.page(view, { guildId: 'g1' });
      return componentCount(payload) > 40 || textOf(json(payload)).length > 4000;
    });
    return tooBig.length ? JSON.stringify(tooBig) : null;
  });
  const helpClick = (customId, values = []) => {
    const log = [];
    const i = { customId, values, guildId: 'g1', guild, user: { id: 'u-fan' }, memberPermissions: { has: () => false }, log };
    i.update = async (p) => log.push(['update', p]);
    i.reply = async (p) => log.push(['reply', p]);
    return i;
  };
  await check('picking a topic in /help -> the page changes in place', async () => {
    const i = helpClick('help:topic', ['leveling']);
    await help.handleComponent(i);
    return i.log[0][0] === 'update' && textOf(json(i.log[0][1])).includes('## ⭐ Levels') ? null : JSON.stringify(i.log);
  });
  await check('picking a command, then Home -> command details, then the home page', async () => {
    const pick = helpClick('help:cmd', ['music']);
    await help.handleComponent(pick);
    const home = helpClick('help:home');
    await help.handleComponent(home);
    const details = textOf(json(pick.log[0][1]));
    return details.includes('**/music loop**') && details.includes('This song') && textOf(json(home.log[0][1])).includes("I'm Cardify") ? null : details;
  });
  await check('!help -> a public home page; picking a topic on it answers just you', async () => {
    const replies = [];
    const message = { content: '!help', guildId: 'g1', reply: async (p) => replies.push(p) };
    if (!help.isTextHelp('!help') || !help.isTextHelp('!HELP music') || help.isTextHelp('!helpme') || help.isTextHelp('I need !help')) return 'isTextHelp wrong';
    await help.handleText(message);
    const ids = walk(json(replies[0]).components).map((c) => c.custom_id).filter(Boolean);
    const click = helpClick('help:topic:pub', ['music']);
    await help.handleComponent(click);
    return !(replies[0].flags & MessageFlags.Ephemeral) && ids.includes('help:topic:pub') && click.log[0][0] === 'reply' && click.log[0][1].flags & MessageFlags.Ephemeral ? null : JSON.stringify(ids);
  });
  await check('!help play / !help pizza -> the /play page / "I don\'t know that one"', async () => {
    const replies = [];
    await help.handleText({ content: '!help play', guildId: 'g1', reply: async (p) => replies.push(p) });
    await help.handleText({ content: '!help pizza', guildId: 'g1', reply: async (p) => replies.push(p) });
    return textOf(json(replies[0])).includes('## 🎵 /play') && replies[1].content.includes("I don't know that one") ? null : JSON.stringify(replies);
  });
  await check('/help topic search -> topics and commands that match', async () => {
    const choices = [];
    await help.handleAutocomplete({ commandName: 'help', options: { getFocused: () => 'level' }, respond: async (c) => choices.push(...c) });
    return choices.some((c) => c.value === 'leveling') && choices.some((c) => c.value === '/levels') ? null : JSON.stringify(choices);
  });
  await check('a help page shows this server\'s rules for it', async () => {
    await run(command('access', 'add-channel', { what: 'leveling', channel: { id: 'c-levels' } }));
    const text = textOf(json(help.page({ topic: 'leveling' }, { guildId: 'g1' })));
    await run(command('access', 'reset', { what: 'leveling' }));
    return text.includes('✅ on · only in <#c-levels> · for everyone') ? null : text;
  });

  console.log('\n----- /setup -----');
  const setupClick = (customId, values = [], { canManage = true } = {}) => {
    const log = [];
    const i = { customId, values, guild, guildId: 'g1', channelId: 'c1', user: { id: 'u-admin', tag: 'admin#0001' }, memberPermissions: { has: () => canManage }, log };
    i.update = async (p) => log.push(['update', p]);
    i.reply = async (p) => log.push(['reply', p]);
    return i;
  };
  const shown = async (customId, values) => {
    const i = setupClick(customId, values);
    await setup.handleComponent(i);
    return json(i.log[0][1]);
  };
  const vcTwo = { id: 'v2', type: discord.ChannelType.GuildVoice };
  guild.channels.cache.set('v2', vcTwo);
  await check('/setup without Manage Server -> refused', async () => {
    const text = answer(await run(command('setup', null, {}, { canManage: false }))).content;
    return text.includes('Manage Server') ? null : text;
  });
  await check('/setup -> a private welcome page with the plan and a "Let\'s go!" button', async () => {
    const payload = answer(await run(command('setup', null)));
    const text = textOf(json(payload));
    return text.includes("## 👋 Hi! Let's set up Cardify") && text.includes('5️⃣') && buttonIds(json(payload)).join() === 'setup:go:jobs' && payload.flags & MessageFlags.Ephemeral ? null : text;
  });
  await check('step 1: pick jobs -> saved right away, the checklist updates', async () => {
    const before = await shown('setup:go:jobs');
    const menu = walk(before.components).find((c) => c.custom_id === 'setup:set:jobs');
    if (menu?.options.length !== 10 || menu.options.find((o) => o.value === 'music').default !== true) return JSON.stringify(menu);
    const after = await shown('setup:set:jobs', ['links', 'roles', 'logs', 'welcome', 'leveling', 'music']);
    const text = textOf(after);
    const states = access.FEATURES.map((f) => `${f.key}:${access.isEnabled('g1', f.key) ? 1 : 0}`).join(' ');
    return text.includes("✅ Saved! I'll do 6 jobs.") && text.includes('⬜ 🛡️ Moderation') && states === 'links:1 roles:1 expressions:0 alerts:0 moderation:0 automod:0 logs:1 welcome:1 leveling:1 music:1' ? null : `${states} ${text}`;
  });
  await check('step 2: pick where I post -> mod log, welcome, goodbye and level-up channels saved', async () => {
    const page = await shown('setup:go:posting');
    const ids = walk(page.components).map((c) => c.custom_id).filter(Boolean);
    if (ids.slice(0, 4).join() !== 'setup:set:logs,setup:set:welcome,setup:set:goodbye,setup:set:levelups') return ids.join();
    const logMenu = walk(page.components).find((c) => c.custom_id === 'setup:set:logs');
    if (logMenu.default_values?.[0]?.id !== 'c-modlog') return JSON.stringify(logMenu);
    await shown('setup:set:welcome', ['c-welcome']);
    await shown('setup:set:goodbye', []);
    const after = await shown('setup:set:levelups', ['c-levels']);
    const text = textOf(after);
    return welcome.channelFor('g1', 'welcome') === 'c-welcome' && welcome.channelFor('g1', 'goodbye') === null && leveling.announceChannel('g1') === 'c-levels' && text.includes("I can't post in <#c-levels> yet")
      ? null
      : text;
  });
  await check('step 3: pick where I work -> command channels, quiet channels and link channels saved', async () => {
    await shown('setup:set:commands', ['c1', 'c-music']);
    await shown('setup:set:quiet', ['c-quiet', 'c-rules']);
    const after = await shown('setup:set:linkchannels', []);
    const rule = access.ruleFor('g1', 'all');
    return rule.channels.join() === 'c1,c-music' && access.ignoredChannels('g1').join() === 'c-quiet,c-rules' && access.ruleFor('g1', 'feature:links').channels.length === 0 && textOf(after).includes('every channel')
      ? null
      : textOf(after);
  });
  await check('step 4: pick who can use what -> music roles, DJ, level roles saved (@everyone means everyone)', async () => {
    await shown('setup:set:musicroles', ['r-artist', 'g1']);
    await shown('setup:set:dj', ['r-gamer']);
    const after = await shown('setup:set:levelroles', []);
    const ids = walk(after.components).map((c) => c.custom_id).filter(Boolean);
    return access.ruleFor('g1', 'feature:music').roles.join() === 'r-artist' && music.musicSettings('g1').djRoleId === 'r-gamer' && access.ruleFor('g1', 'feature:leveling').roles.length === 0 && ids.includes('setup:set:linkroles')
      ? null
      : ids.join();
  });
  await check('step 5: pick music rooms and volume -> saved', async () => {
    await shown('setup:set:voice', ['v1', 'v2']);
    const after = await shown('setup:set:volume', ['75']);
    const settings = music.musicSettings('g1');
    return settings.voiceChannels.join() === 'v1,v2' && settings.volume === 75 && textOf(after).includes('Music starts at 75%') ? null : JSON.stringify(settings);
  });
  await check('the last page -> a summary of everything and what to try next', async () => {
    const text = textOf(await shown('setup:go:done'));
    const needed = ['## 🎉 All done!', '**✅ My jobs:** 🔗 Link cards, 🎭 Role panels, 📋 Mod log, 👋 Welcome messages, ⭐ Levels, 🎵 Music', '**⛔ Turned off:**', '👋 **Welcome:** <#c-welcome> · 🚪 **Goodbye:** not set', '⭐ **Level-ups:** <#c-levels>', 'I join <#v1>, <#v2>', '`/roles create`'];
    return needed.every((n) => text.includes(n)) && !text.includes('/alerts twitch') ? null : text;
  });
  await check('every setup step fits in one message', async () => {
    const tooBig = [];
    for (const step of setup.STEPS) {
      const payload = setup.stepPayload(step, guild, '✅ Saved!');
      if (componentCount(payload) > 40 || textOf(json(payload)).length > 4000) tooBig.push(step);
    }
    return tooBig.length ? tooBig.join() : null;
  });
  await check('someone without Manage Server clicking setup -> refused; "Who can use what" hides where I post', async () => {
    const i = setupClick('setup:go:jobs', [], { canManage: false });
    await setup.handleComponent(i);
    const view = setupClick('access:view', [], { canManage: false });
    await setup.handleComponent(view);
    const text = textOf(json(view.log[0][1]));
    return i.log[0][1].content.includes('Only people who can manage the server') && text.includes('## 🔐 Who can use what') && !text.includes('Where I post') ? null : text;
  });
  await check('turning jobs off in /setup -> their commands stop', async () => {
    const problem = access.commandProblem(asMember('mod', { canManage: true }));
    await shown('setup:set:jobs', access.FEATURES.map((f) => f.key));
    access.setRule('g1', 'all', { channels: [] });
    access.setIgnored('g1', []);
    return problem?.includes('Moderation** is turned off') ? null : problem;
  });

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL FEATURE TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('FEATURE TESTS CRASHED:', err);
  process.exit(1);
});
