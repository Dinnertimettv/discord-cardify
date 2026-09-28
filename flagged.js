// Cards hidden with "Flag as NSFW", saved to data/flagged.json so "Undo flag"
// can put them back exactly as they were - even after a restart.
const fs = require('fs');
const path = require('path');

const FLAGGED_FILE = process.env.BOT_FLAGGED_FILE || path.join(__dirname, 'data', 'flagged.json');
// The oldest flags lose their undo past this, so the file can't grow forever.
const MAX_SAVED = 500;

let saved = null; // message id -> the message's components before it was flagged

function load() {
  if (!saved) {
    try {
      saved = JSON.parse(fs.readFileSync(FLAGGED_FILE, 'utf8'));
    } catch {
      saved = {};
    }
  }
  return saved;
}

function write() {
  // Write to a temp file first so a crash mid-write can't corrupt the file.
  fs.mkdirSync(path.dirname(FLAGGED_FILE), { recursive: true });
  fs.writeFileSync(`${FLAGGED_FILE}.tmp`, JSON.stringify(saved));
  fs.renameSync(`${FLAGGED_FILE}.tmp`, FLAGGED_FILE);
}

function saveFlaggedCard(messageId, components) {
  const all = load();
  delete all[messageId]; // re-added last, so it counts as the newest
  all[messageId] = components;
  const ids = Object.keys(all); // oldest first (message ids are too big to be sorted as numbers)
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_SAVED))) delete all[id];
  write();
}

function getFlaggedCard(messageId) {
  return load()[messageId] ?? null;
}

function forgetFlaggedCard(messageId) {
  const all = load();
  if (!(messageId in all)) return;
  delete all[messageId];
  write();
}

module.exports = { saveFlaggedCard, getFlaggedCard, forgetFlaggedCard };
