// /restart: the bot's owner restarts it from Discord - handy from a phone.
// It only works while the keep-alive (scripts/keep-alive.js, started with
// "npm run background") is running the bot: the bot just exits, and the
// keep-alive starts it again a moment later. Started with "npm start" in a
// window instead, exiting would leave it off, so it says how to set that up.
const { InteractionContextType, MessageFlags, PermissionFlagsBits, Routes, SlashCommandBuilder } = require('discord.js');
const { RESTART_EXIT_CODE } = require('../instance');
const { createStore } = require('../store');

// Remembers the /restart reply, so the restarted bot can change it to "back online".
const store = createStore('restart.json', { pending: null });
// Discord lets a reply be edited for 15 minutes.
const REPLY_EDITABLE_MS = 14 * 60_000;

const RESTART_COMMAND = new SlashCommandBuilder()
  .setName('restart')
  .setDescription("Restart me (only my owner can) - I'm back in a few seconds")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  // Also in a DM with me, so it works from anywhere.
  .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM);

// Swapped out by the tests.
const control = {
  exit: (code) => process.exit(code),
  isKeptAlive: () => process.env.SPORK_KEEP_ALIVE === '1',
};

// The owner is whoever owns the app in the Developer Portal (or its team), plus
// anyone in BOT_OWNER_IDS in .env.
async function isOwner(interaction) {
  const extra = (process.env.BOT_OWNER_IDS || '').split(',').map((id) => id.trim());
  if (extra.includes(interaction.user.id)) return true;
  const app = await interaction.client.application.fetch();
  const owner = app.owner;
  return Boolean(owner?.members ? owner.members.has(interaction.user.id) : owner?.id === interaction.user.id);
}

async function handleCommand(interaction) {
  if (interaction.commandName !== 'restart') return false;
  const reply = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
  if (!(await isOwner(interaction))) {
    await reply("Only my owner can restart me.");
    return true;
  }
  if (!control.isKeptAlive()) {
    await reply(
      "I'm running in a PowerShell window, so if I stopped I couldn't start again by myself. On the PC, close that window and run " +
        '`npm run background` (and `npm run autostart` to start with Windows) - then `/restart` works from anywhere.'
    );
    return true;
  }
  await reply('🔄 Restarting - back in a few seconds.');
  store.load().pending = { applicationId: interaction.applicationId, token: interaction.token, at: Date.now() };
  store.save();
  console.log(`Restarting - ${interaction.user.tag} used /restart.`);
  await interaction.client.destroy();
  control.exit(RESTART_EXIT_CODE);
  return true;
}

// After a /restart, changes its reply to say the bot is back.
async function announceBack(client, version) {
  const pending = store.load().pending;
  if (!pending) return;
  store.load().pending = null;
  store.save();
  if (Date.now() - pending.at > REPLY_EDITABLE_MS) return;
  await client.rest
    .patch(Routes.webhookMessage(pending.applicationId, pending.token, '@original'), {
      body: { content: `✅ Back online - version ${version}.` },
      auth: false,
    })
    .catch((err) => console.error("Couldn't update the /restart reply:", err.message));
}

module.exports = { commands: [RESTART_COMMAND], handleCommand, announceBack, control };
