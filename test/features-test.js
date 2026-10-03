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
    },
    deferReply: async (o) => { interaction.deferred = true; log.push(['deferReply', o]); },
    reply: async (p) => { interaction.replied = true; log.push(['reply', p]); },
    editReply: async (p) => { log.push(['editReply', p]); },
  };
  return interaction;
}
const answer = (interaction) => interaction.log.findLast((l) => l[0] === 'reply' || l[0] === 'editReply')?.[1];
const run = async (interaction) => {
  for (const feature of [roles, expressions]) if (await feature.handleCommand(interaction)) return interaction;
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

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL FEATURE TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('FEATURE TESTS CRASHED:', err);
  process.exit(1);
});
