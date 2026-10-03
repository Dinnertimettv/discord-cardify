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
  };
  return interaction;
}
const answer = (interaction) => interaction.log.findLast((l) => l[0] === 'reply' || l[0] === 'editReply')?.[1];
const run = async (interaction) => {
  for (const feature of [roles, expressions, alerts, logs, moderation, automod, welcome, leveling]) if (await feature.handleCommand(interaction)) return interaction;
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

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL FEATURE TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('FEATURE TESTS CRASHED:', err);
  process.exit(1);
});
