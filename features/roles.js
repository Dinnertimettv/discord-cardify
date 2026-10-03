// Role panels: a message members use to give themselves roles - by reacting
// with an emoji, clicking a button, or picking from a dropdown menu (each
// panel's style). Admins set them up with /roles; they're saved in
// data/roles.json so they keep working after restarts.
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
} = require('discord.js');
const { createStore } = require('../store');

const store = createStore('roles.json', { panels: {} });

const PANEL_COLOR = 0x5865f2;
// Discord allows 20 different reactions on a message, so every style stops
// there too (and 20 buttons fit in 4 rows of 5).
const MAX_ROLES_PER_PANEL = 20;

// A panel can never hand out a role with any of these - they'd give whoever
// clicks moderator powers.
const MODERATOR_PERMISSIONS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.ManageGuildExpressions,
  PermissionFlagsBits.ManageEvents,
  PermissionFlagsBits.ManageNicknames,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.MentionEveryone,
  PermissionFlagsBits.ViewAuditLog,
];

const ROLES_COMMAND = new SlashCommandBuilder()
  .setName('roles')
  .setDescription('Role panels members use to pick their own roles')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) =>
    sub
      .setName('create')
      .setDescription('Post a new role panel in this channel')
      .addStringOption((o) => o.setName('title').setDescription('The panel title').setRequired(true).setMaxLength(100))
      .addStringOption((o) =>
        o
          .setName('style')
          .setDescription('How members pick their roles')
          .setRequired(true)
          .addChoices(
            { name: 'Buttons', value: 'buttons' },
            { name: 'Dropdown menu', value: 'menu' },
            { name: 'Emoji reactions', value: 'reactions' }
          )
      )
      .addStringOption((o) => o.setName('description').setDescription('Text under the title').setMaxLength(1000))
      .addBooleanOption((o) =>
        o.setName('one-only').setDescription('Members can have only one role from this panel at a time (default: no)')
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Add a role to a panel (or change its emoji or label)')
      .addStringOption((o) => o.setName('panel').setDescription("The panel's message link or ID").setRequired(true))
      .addRoleOption((o) => o.setName('role').setDescription('The role to hand out').setRequired(true))
      .addStringOption((o) => o.setName('emoji').setDescription('Its emoji (needed for reaction panels)'))
      .addStringOption((o) =>
        o.setName('label').setDescription("Button or menu text (default: the role's name)").setMaxLength(80)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Remove a role from a panel')
      .addStringOption((o) => o.setName('panel').setDescription("The panel's message link or ID").setRequired(true))
      .addRoleOption((o) => o.setName('role').setDescription('The role to remove').setRequired(true))
  )
  .addSubcommand((sub) => sub.setName('list').setDescription("List this server's role panels"));

const STYLE_NAMES = { buttons: 'buttons', menu: 'dropdown menu', reactions: 'emoji reactions' };

// ---------------------------------------------------------------------------
// Emojis
// ---------------------------------------------------------------------------

const CUSTOM_EMOJI = /^<(a?):(\w{2,32}):(\d{17,20})>$/;
const UNICODE_EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]️?⃣)/u;

// What identifies an emoji on a reaction: a custom emoji's id, or the
// character itself (without the variation selector some keyboards add).
function emojiKey(emoji) {
  if (!emoji) return null;
  if (typeof emoji === 'string') return emoji.match(CUSTOM_EMOJI)?.[3] ?? emoji.replace(/️/g, '');
  return emoji.id ?? emoji.name?.replace(/️/g, '') ?? null;
}

function isEmoji(text) {
  return CUSTOM_EMOJI.test(text) || UNICODE_EMOJI.test(text);
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

function panels() {
  return store.load().panels;
}

// A panel message link (…/channels/<server>/<channel>/<message>) or a bare id.
function panelIdFrom(text) {
  return text?.trim().match(/(\d{17,20})\/?$/)?.[1] ?? null;
}

function panelPayload(panel) {
  const roles = panel.options.map((option) => `${option.emoji ? `${option.emoji}  ` : ''}<@&${option.roleId}>`);
  const how = {
    reactions: 'React to get a role - remove your reaction to drop it.',
    buttons: 'Click a button to get a role - click it again to drop it.',
    menu: 'Pick your roles from the menu.',
  }[panel.style];
  const text = [
    `### ${panel.title}`,
    panel.description,
    roles.length ? roles.join('\n') : '*No roles yet - an admin adds them with `/roles add`.*',
    `-# ${how}${panel.single ? ' You can have one at a time.' : ''}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const components = [new ContainerBuilder().setAccentColor(PANEL_COLOR).addTextDisplayComponents(new TextDisplayBuilder().setContent(text))];

  if (panel.style === 'buttons') {
    for (let i = 0; i < panel.options.length; i += 5) {
      components.push(
        new ActionRowBuilder().addComponents(
          panel.options.slice(i, i + 5).map((option) => {
            const button = new ButtonBuilder()
              .setCustomId(`role:${option.roleId}`)
              .setLabel(option.label)
              .setStyle(ButtonStyle.Secondary);
            if (option.emoji) button.setEmoji(option.emoji);
            return button;
          })
        )
      );
    }
  } else if (panel.style === 'menu' && panel.options.length > 0) {
    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('role-menu')
          .setPlaceholder(panel.single ? 'Pick a role' : 'Pick your roles')
          .setMinValues(0)
          .setMaxValues(panel.single ? 1 : panel.options.length)
          .addOptions(
            panel.options.map((option) => ({
              label: option.label,
              value: option.roleId,
              ...(option.emoji && { emoji: option.emoji }),
            }))
          )
      )
    );
  }
  return { flags: MessageFlags.IsComponentsV2, components, allowedMentions: { parse: [] } };
}

async function fetchPanelMessage(guild, panel) {
  const channel = await guild.channels.fetch(panel.channelId);
  return channel.messages.fetch(panel.messageId);
}

// Why a role can't go on a panel, or null if it can.
function roleProblem(role, guild) {
  if (!role) return "That role doesn't exist anymore.";
  if (role.id === guild.id) return "@everyone can't be handed out - everyone already has it.";
  if (role.managed) return `**${role.name}** belongs to a bot or integration, so it can't be handed out.`;
  if (MODERATOR_PERMISSIONS.some((permission) => role.permissions.has(permission, false))) {
    return `**${role.name}** has moderator-level permissions, so a role panel won't hand it out.`;
  }
  if (!role.editable) {
    return `I can't give out **${role.name}** - drag my role above it in Server Settings → Roles.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// /roles
// ---------------------------------------------------------------------------

function reply(interaction, content) {
  const payload = { content, allowedMentions: { parse: [] } };
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

async function handleCommand(interaction) {
  if (interaction.commandName !== ROLES_COMMAND.name) return false;
  // Discord hides /roles from people without Manage Roles by default, but a
  // server's admins can change that in Integrations - so check here too.
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)) {
    await reply(interaction, 'Only people with the **Manage Roles** permission can use /roles.');
    return true;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const sub = interaction.options.getSubcommand();
  if (sub === 'create') await createPanel(interaction);
  else if (sub === 'add') await addRole(interaction);
  else if (sub === 'remove') await removeRole(interaction);
  else if (sub === 'list') await listPanels(interaction);
  return true;
}

async function createPanel(interaction) {
  const panel = {
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    title: interaction.options.getString('title', true),
    description: interaction.options.getString('description') ?? '',
    style: interaction.options.getString('style', true),
    single: interaction.options.getBoolean('one-only') ?? false,
    options: [],
  };
  const message = await interaction.channel.send(panelPayload(panel));
  panel.messageId = message.id;
  panels()[message.id] = panel;
  store.save();
  console.log(`/roles: ${interaction.user.tag} (${interaction.user.id}) created a ${panel.style} role panel in channel ${panel.channelId}.`);
  await reply(
    interaction,
    `Posted the role panel (${STYLE_NAMES[panel.style]}): ${message.url}\nAdd roles with \`/roles add panel:${message.id} role:…\``
  );
}

async function addRole(interaction) {
  const panel = panels()[panelIdFrom(interaction.options.getString('panel', true))];
  if (!panel || panel.guildId !== interaction.guildId) return reply(interaction, "I can't find that panel - use `/roles list` to see this server's panels.");
  const role = interaction.options.getRole('role', true);
  const problem = roleProblem(interaction.guild.roles.cache.get(role.id) ?? role, interaction.guild);
  if (problem) return reply(interaction, problem);

  const emoji = interaction.options.getString('emoji')?.trim() || null;
  if (emoji && !isEmoji(emoji)) return reply(interaction, `\`${emoji}\` isn't an emoji - use one like 🎮 or a custom one from this server.`);
  const existing = panel.options.find((option) => option.roleId === role.id);
  if (panel.style === 'reactions' && !emoji && !existing?.emoji) return reply(interaction, 'Reaction panels need an emoji for each role.');
  if (!existing && panel.options.length >= MAX_ROLES_PER_PANEL) return reply(interaction, `A panel can have at most ${MAX_ROLES_PER_PANEL} roles.`);
  if (emoji && panel.options.some((option) => option.roleId !== role.id && emojiKey(option.emoji) === emojiKey(emoji))) {
    return reply(interaction, 'Another role on this panel already uses that emoji.');
  }

  const option = existing ?? { roleId: role.id };
  const oldEmoji = option.emoji;
  option.emoji = emoji ?? option.emoji ?? null;
  option.label = interaction.options.getString('label') ?? existing?.label ?? role.name;
  if (!existing) panel.options.push(option);

  const message = await fetchPanelMessage(interaction.guild, panel);
  try {
    await message.edit(panelPayload(panel));
    if (panel.style === 'reactions') {
      if (oldEmoji && emojiKey(oldEmoji) !== emojiKey(option.emoji)) {
        await message.reactions.cache.get(emojiKey(oldEmoji))?.remove().catch(() => {});
      }
      await message.react(option.emoji);
    }
  } catch (err) {
    // Usually an emoji from another server, which bots can't use here.
    if (!existing) panel.options.pop();
    else option.emoji = oldEmoji;
    await message.edit(panelPayload(panel)).catch(() => {});
    return reply(interaction, `Discord wouldn't accept that - if it's a custom emoji, it has to be from this server. (${err.message})`);
  }
  store.save();
  console.log(`/roles: ${interaction.user.tag} (${interaction.user.id}) added role ${role.id} to panel ${panel.messageId}.`);
  return reply(interaction, `${existing ? 'Updated' : 'Added'} <@&${role.id}> on the panel: ${message.url}`);
}

async function removeRole(interaction) {
  const panel = panels()[panelIdFrom(interaction.options.getString('panel', true))];
  if (!panel || panel.guildId !== interaction.guildId) return reply(interaction, "I can't find that panel - use `/roles list` to see this server's panels.");
  const role = interaction.options.getRole('role', true);
  const option = panel.options.find((o) => o.roleId === role.id);
  if (!option) return reply(interaction, `<@&${role.id}> isn't on that panel.`);
  panel.options = panel.options.filter((o) => o !== option);
  const message = await fetchPanelMessage(interaction.guild, panel);
  await message.edit(panelPayload(panel));
  if (panel.style === 'reactions' && option.emoji) await message.reactions.cache.get(emojiKey(option.emoji))?.remove().catch(() => {});
  store.save();
  console.log(`/roles: ${interaction.user.tag} (${interaction.user.id}) removed role ${role.id} from panel ${panel.messageId}.`);
  return reply(interaction, `Removed <@&${role.id}> from the panel. Members who already have it keep it.`);
}

async function listPanels(interaction) {
  const mine = Object.values(panels()).filter((panel) => panel.guildId === interaction.guildId);
  if (mine.length === 0) return reply(interaction, 'This server has no role panels yet - make one with `/roles create`.');
  const lines = mine.map(
    (panel) =>
      `• **${panel.title}** - ${STYLE_NAMES[panel.style]}, ${panel.options.length} role(s)${panel.single ? ', one at a time' : ''}\n` +
      `  https://discord.com/channels/${panel.guildId}/${panel.channelId}/${panel.messageId}`
  );
  return reply(interaction, lines.join('\n').slice(0, 2000));
}

// ---------------------------------------------------------------------------
// Members picking roles
// ---------------------------------------------------------------------------

// Gives or takes one role, after re-checking it's still safe to hand out (its
// permissions may have changed since it was added). Returns what happened.
async function setRole(member, roleId, give) {
  const role = member.guild.roles.cache.get(roleId);
  const problem = roleProblem(role, member.guild);
  if (problem) return { problem };
  if (member.roles.cache.has(roleId) === give) return { changed: false, role };
  await (give ? member.roles.add(roleId, 'Role panel') : member.roles.remove(roleId, 'Role panel'));
  return { changed: true, role };
}

// Clicking a role button: toggles that role (and, on a one-at-a-time panel,
// drops the panel's other roles).
async function handleButton(interaction, roleId) {
  const panel = panels()[interaction.message.id];
  if (!panel?.options.some((option) => option.roleId === roleId)) {
    return reply(interaction, "This role panel isn't set up anymore.");
  }
  const member = interaction.member;
  const give = !member.roles.cache.has(roleId);
  const result = await setRole(member, roleId, give);
  if (result.problem) return reply(interaction, result.problem);
  if (give && panel.single) {
    for (const option of panel.options) if (option.roleId !== roleId) await setRole(member, option.roleId, false);
  }
  return reply(interaction, give ? `You now have the **${result.role.name}** role.` : `Removed the **${result.role.name}** role.`);
}

// Picking from a role menu: the member ends up with exactly the panel's roles
// they picked.
async function handleSelect(interaction) {
  const panel = panels()[interaction.message.id];
  if (!panel) return reply(interaction, "This role panel isn't set up anymore.");
  const picked = new Set(interaction.values);
  const added = [];
  const removed = [];
  const problems = [];
  for (const option of panel.options) {
    const result = await setRole(interaction.member, option.roleId, picked.has(option.roleId));
    if (result.problem) problems.push(result.problem);
    else if (result.changed) (picked.has(option.roleId) ? added : removed).push(`**${result.role.name}**`);
  }
  const lines = [
    added.length && `Added: ${added.join(', ')}`,
    removed.length && `Removed: ${removed.join(', ')}`,
    !added.length && !removed.length && !problems.length && 'Your roles were already set that way.',
    ...problems,
  ].filter(Boolean);
  return reply(interaction, lines.join('\n'));
}

// Reacting on a reaction panel gives the role; removing the reaction takes it.
async function handleReaction(reaction, user, added) {
  if (user.bot) return;
  if (reaction.partial) reaction = await reaction.fetch().catch(() => null);
  const panel = reaction && panels()[reaction.message.id];
  if (!panel || panel.style !== 'reactions' || !reaction.message.guild) return;
  const option = panel.options.find((o) => emojiKey(o.emoji) === emojiKey(reaction.emoji));
  if (!option) return;
  const member = await reaction.message.guild.members.fetch(user.id);
  const result = await setRole(member, option.roleId, added);
  if (result.problem) {
    console.error(`Role panel ${panel.messageId}: ${result.problem.replace(/\*\*/g, '')}`);
    return;
  }
  if (added && panel.single) {
    for (const other of panel.options) {
      if (other.roleId === option.roleId) continue;
      await setRole(member, other.roleId, false);
      // Their other reaction would otherwise suggest they still have that role.
      await reaction.message.reactions.cache.get(emojiKey(other.emoji))?.users.remove(user.id).catch(() => {});
    }
  }
}

// A deleted panel message takes its panel with it.
function forgetDeletedPanel(messageId) {
  if (!panels()[messageId]) return;
  delete panels()[messageId];
  store.save();
}

module.exports = {
  commands: [ROLES_COMMAND],
  handleCommand,
  handleButton,
  handleSelect,
  handleReaction,
  forgetDeletedPanel,
  // For tests.
  panelPayload,
  emojiKey,
};
