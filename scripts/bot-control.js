// Checks on or stops the copy of the bot running on this PC, wherever it was
// started from (a terminal window, or in the background with no window).
//   npm run status
//   npm run stop
const { findRunningBot } = require('../instance');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const command = process.argv[2];
  const pid = await findRunningBot();

  if (command === 'status') {
    console.log(pid ? `The bot is running (process ${pid}).` : "The bot isn't running on this PC.");
    return;
  }

  if (command === 'stop') {
    if (!pid) {
      console.log("The bot isn't running on this PC.");
      return;
    }
    process.kill(pid);
    // The lock port frees up as soon as the process has exited.
    for (let i = 0; i < 40 && (await findRunningBot()); i++) await sleep(250);
    console.log((await findRunningBot()) ? `Asked process ${pid} to stop, but it's still running.` : `Stopped the bot (process ${pid}).`);
    return;
  }

  console.log('Usage: npm run status | npm run stop');
})();
