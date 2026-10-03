// Adding the server's own emojis and soundboard sounds: /emoji add and
// /sound add, for people who can manage the server's expressions.
const {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  SlashCommandBuilder,
} = require('discord.js');

const CUSTOM_EMOJI = /^<(a?):(\w{2,32}):(\d{17,20})>$/;

const EMOJI_COMMAND = new SlashCommandBuilder()
  .setName('emoji')
  .setDescription("Add emojis to this server")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuildExpressions)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Add an emoji from an image, a link, or an emoji from another server')
      .addStringOption((o) =>
        o.setName('name').setDescription('Its name, 2-32 letters, numbers or _ (default: the copied emoji\'s name)').setMaxLength(32)
      )
      .addAttachmentOption((o) => o.setName('image').setDescription('A PNG, JPG, GIF or WebP image, at most 256 KB'))
      .addStringOption((o) => o.setName('link').setDescription('An https link to an image'))
      .addStringOption((o) => o.setName('copy').setDescription('An emoji from another server to copy (paste it here)'))
  );

const SOUND_COMMAND = new SlashCommandBuilder()
  .setName('sound')
  .setDescription("Add sounds to this server's soundboard")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuildExpressions)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Add a sound from an MP3 or OGG file (at most 512 KB and about 5 seconds)')
      .addStringOption((o) => o.setName('name').setDescription('Its name, 2-32 characters').setRequired(true).setMinLength(2).setMaxLength(32))
      .addAttachmentOption((o) => o.setName('file').setDescription('The MP3 or OGG file').setRequired(true))
      .addStringOption((o) => o.setName('emoji').setDescription('An emoji shown next to it'))
      .addIntegerOption((o) => o.setName('volume').setDescription('Volume from 1 to 100 (default 100)').setMinValue(1).setMaxValue(100))
  );

const MAX_EMOJI_BYTES = 256 * 1024;
const MAX_SOUND_BYTES = 512 * 1024;

function reply(interaction, content) {
  const payload = { content, allowedMentions: { parse: [] } };
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

function canManageExpressions(interaction) {
  const permissions = interaction.memberPermissions;
  return Boolean(
    permissions?.has(PermissionFlagsBits.ManageGuildExpressions) || permissions?.has(PermissionFlagsBits.CreateGuildExpressions)
  );
}

// Only public https links - never this PC or its home network, which the bot
// can reach but nobody else should be able to point it at.
function isSafeImageLink(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const privateHost =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^(?:0|10|127)\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^(?:::1?|fc|fd|fe80)/.test(host) ||
    !host.includes('.') && !host.includes(':');
  return url.protocol === 'https:' && !privateHost;
}

// Discord's error, in plain words.
function explain(err, what) {
  if (err.code === RESTJSONErrorCodes.MaximumNumberOfEmojisReached) return 'This server has no free emoji slots left.';
  if (err.code === RESTJSONErrorCodes.MaximumNumberOfSoundboardSoundsReached) return 'This server has no free soundboard slots left.';
  if (err.code === RESTJSONErrorCodes.MissingPermissions) return `I don't have permission to add ${what} here - I need **Create Expressions**.`;
  return `Discord wouldn't add that ${what}: ${err.message}`;
}

async function addEmoji(interaction) {
  const image = interaction.options.getAttachment('image');
  const link = interaction.options.getString('link')?.trim();
  const copy = interaction.options.getString('copy')?.trim().match(CUSTOM_EMOJI);
  if ([image, link, copy].filter(Boolean).length !== 1) {
    return reply(interaction, 'Give exactly one of: an **image**, a **link**, or an emoji to **copy**.');
  }
  if (link && !isSafeImageLink(link)) return reply(interaction, 'The link has to be a public https link to an image.');
  if (image && image.size > MAX_EMOJI_BYTES) return reply(interaction, 'That image is over 256 KB - Discord won\'t take emojis that big.');
  if (image && !image.contentType?.startsWith('image/')) return reply(interaction, "That file isn't an image.");

  const name = (interaction.options.getString('name') ?? copy?.[2] ?? '').replace(/[^\w]/g, '_');
  if (name.length < 2) return reply(interaction, 'Give it a **name** of 2-32 letters, numbers or underscores.');

  const source = image?.url ?? link ?? `https://cdn.discordapp.com/emojis/${copy[3]}.${copy[1] ? 'gif' : 'png'}`;
  try {
    const emoji = await interaction.guild.emojis.create({ attachment: source, name, reason: `Added by ${interaction.user.tag} with /emoji` });
    console.log(`/emoji: ${interaction.user.tag} (${interaction.user.id}) added :${emoji.name}: (${emoji.id}).`);
    return reply(interaction, `Added ${emoji} as \`:${emoji.name}:\`.`);
  } catch (err) {
    return reply(interaction, explain(err, 'emoji'));
  }
}

async function addSound(interaction) {
  const file = interaction.options.getAttachment('file', true);
  const isAudio = /^audio\/(?:mpeg|mp3|ogg)/.test(file.contentType ?? '') || /\.(?:mp3|ogg)$/i.test(file.name ?? '');
  if (!isAudio) return reply(interaction, 'The sound has to be an MP3 or OGG file.');
  if (file.size > MAX_SOUND_BYTES) return reply(interaction, 'That file is over 512 KB - Discord won\'t take soundboard sounds that big.');

  const emojiText = interaction.options.getString('emoji')?.trim();
  const custom = emojiText?.match(CUSTOM_EMOJI);
  const volume = (interaction.options.getInteger('volume') ?? 100) / 100;
  try {
    const sound = await interaction.guild.soundboardSounds.create({
      file: file.url,
      name: interaction.options.getString('name', true),
      contentType: /ogg/i.test(file.contentType ?? file.name) ? 'audio/ogg' : 'audio/mpeg',
      volume,
      ...(custom ? { emojiId: custom[3] } : emojiText ? { emojiName: emojiText } : {}),
      reason: `Added by ${interaction.user.tag} with /sound`,
    });
    console.log(`/sound: ${interaction.user.tag} (${interaction.user.id}) added soundboard sound "${sound.name}".`);
    return reply(interaction, `Added **${sound.name}** to the soundboard.`);
  } catch (err) {
    // Sounds longer than about 5 seconds are refused with a form error.
    return reply(interaction, explain(err, 'sound'));
  }
}

async function handleCommand(interaction) {
  if (interaction.commandName !== EMOJI_COMMAND.name && interaction.commandName !== SOUND_COMMAND.name) return false;
  if (!canManageExpressions(interaction)) {
    await reply(interaction, 'Only people who can manage this server\'s emojis and sounds can use this.');
    return true;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (interaction.commandName === EMOJI_COMMAND.name) await addEmoji(interaction);
  else await addSound(interaction);
  return true;
}

module.exports = {
  commands: [EMOJI_COMMAND, SOUND_COMMAND],
  handleCommand,
  // For tests.
  isSafeImageLink,
};
