// Small JSON files in data/ that features keep their state in (role panels,
// alerts, ...), so it survives restarts. Writes go to a temp file first, so a
// crash mid-write can't corrupt them. BOT_DATA_DIR moves the folder (the tests
// use a temporary one).
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.BOT_DATA_DIR || path.join(__dirname, 'data');

function createStore(fileName, defaults) {
  const file = path.join(DATA_DIR, fileName);
  let data = null;

  function load() {
    if (!data) {
      try {
        data = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        data = structuredClone(defaults);
      }
    }
    return data;
  }

  function save() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(load(), null, 2));
    fs.renameSync(`${file}.tmp`, file);
  }

  return { load, save };
}

module.exports = { createStore };
