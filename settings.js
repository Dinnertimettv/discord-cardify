// Per-server settings, changed with the /embeds command and saved to
// data/settings.json so they survive restarts.
const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = process.env.BOT_SETTINGS_FILE || path.join(__dirname, 'data', 'settings.json');

const DEFAULTS = {
  // Language posts get translated into ('off' = never translate).
  language: 'en',
  // Repost fixed links under the sharer's own name and avatar (via a webhook)
  // instead of as the bot with a "shared:" line.
  postAsSharer: true,
  // Channels where the bot leaves links alone (threads follow their channel).
  disabledChannels: [],
};

let data = null;

function load() {
  if (!data) {
    try {
      data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    } catch {
      data = { guilds: {} };
    }
  }
  return data;
}

function getGuildSettings(guildId) {
  return { ...DEFAULTS, ...(guildId ? load().guilds[guildId] : undefined) };
}

function updateGuildSettings(guildId, changes) {
  const all = load();
  all.guilds[guildId] = { ...getGuildSettings(guildId), ...changes };
  // Write to a temp file first so a crash mid-write can't corrupt the settings.
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(`${SETTINGS_FILE}.tmp`, JSON.stringify(all, null, 2));
  fs.renameSync(`${SETTINGS_FILE}.tmp`, SETTINGS_FILE);
  return all.guilds[guildId];
}

module.exports = { getGuildSettings, updateGuildSettings };
