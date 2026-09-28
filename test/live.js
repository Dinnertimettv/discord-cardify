// Live end-to-end test against real Discord. Posts a message into the private
// test channel through the test webhook (TEST_WEBHOOK_URL), waits for the
// running bot to respond, then prints exactly what it posted - its text, its
// own cards, Discord's link previews, and its buttons - plus anything the bot
// logged meanwhile. The bot must already be running (npm start).
//
//   npm run test:live -- "check this https://x.com/jack/status/20"
//
// Buttons can't be clicked through the API; those are covered by npm test.
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { findRunningBot } = require('../instance');

const { DISCORD_TOKEN, TEST_WEBHOOK_URL, TEST_CHANNEL_ID } = process.env;
const LOG_FILE = path.join(__dirname, '..', 'logs', 'bot.log');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function discord(route) {
  const res = await fetch(`https://discord.com/api/v10${route}`, {
    headers: { Authorization: `Bot ${DISCORD_TOKEN}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${route} -> HTTP ${res.status}`);
  return res.json();
}

function flattenComponents(components) {
  return components.flatMap((c) => [c, ...flattenComponents(c.components ?? []), ...(c.accessory ? [c.accessory] : [])]);
}

function describeMessage(message, index, total) {
  const postedAs = message.webhook_id ? ` (posted as "${message.author.username}")` : '';
  const lines = [`\n-- Bot message ${index + 1} of ${total}${postedAs} --`];
  if (message.content) {
    lines.push('text:', ...message.content.split('\n').map((line) => `  | ${line}`));
  }
  for (const embed of message.embeds) {
    // The bot's own cards never set a top-level url; Discord's link previews do.
    if (embed.type === 'components') {
      // Newer previews come as layout components: text blocks and media galleries.
      const parts = flattenComponents(embed.components ?? []);
      const text = parts.map((c) => c.content).filter(Boolean).join(' ').replace(/\s+/g, ' ');
      const media = parts.flatMap((c) => [...(c.items ?? []).map((item) => item.media), c.media]).filter(Boolean);
      const kind = media.some((m) => /\.(mp4|webm|mov)(\?|$)/i.test(m.url) || m.content_type?.startsWith('video'))
        ? 'video'
        : media.length ? 'image' : 'no media';
      lines.push(`link preview: "${text.slice(0, 120)}" [${kind}]`);
    } else if (embed.url) {
      const media = embed.video ? 'video' : embed.image || embed.thumbnail ? 'image' : 'no media';
      lines.push(`link preview: ${embed.provider?.name ?? embed.type} - "${embed.title ?? embed.author?.name ?? embed.url}" [${media}]`);
    } else {
      const color = embed.color ? `#${embed.color.toString(16).padStart(6, '0')}` : 'default';
      const text = (embed.description ?? '').replace(/\s+/g, ' ');
      const extras = [embed.image && 'image', ...(embed.fields ?? []).map((field) => `field "${field.name}"`)].filter(Boolean);
      lines.push(`bot card: ${embed.author?.name ?? embed.title ?? '(no header)'} | color ${color}${extras.length ? ` | ${extras.join(', ')}` : ''}`);
      if (text) lines.push(`  "${text.length > 160 ? `${text.slice(0, 160)}...` : text}"`);
    }
  }
  // Card messages (Components V2): cards, text, and gaps instead of content/embeds.
  if (message.flags & 32768) {
    for (const c of message.components) {
      if (c.type === 10) lines.push(...c.content.split('\n').map((line) => `  | ${line}`));
      if (c.type === 14) lines.push('  ~ gap ~');
      if (c.type === 17) {
        const parts = flattenComponents(c.components);
        const text = parts.filter((p) => p.type === 10).map((p) => p.content).join(' / ').replace(/\s+/g, ' ');
        const media = parts.flatMap((p) => (p.items ?? []).map((i) => i.media));
        const mediaNote = media.map((m) => `${m.content_type ?? '?'} ${m.loading_state === 2 ? 'loaded' : `state ${m.loading_state}`}`).join(', ');
        const color = `#${(c.accent_color ?? 0).toString(16).padStart(6, '0')}`;
        lines.push(`card ${color}: ${text.length > 320 ? `${text.slice(0, 320)}...` : text}${media.length ? `\n  media: ${mediaNote}` : ''}`);
      }
    }
  }
  const buttons = flattenComponents(message.components).filter((c) => c.type === 2);
  if (buttons.length) {
    lines.push(`buttons: ${buttons.map((b) => `[${b.label}${b.disabled ? ' (disabled)' : ''}]`).join(' ')}`);
  }
  return lines.join('\n');
}

(async () => {
  const text = process.argv.slice(2).join(' ').trim();
  if (!text) {
    console.error('Usage: npm run test:live -- "message text with links"');
    process.exit(1);
  }
  if (!TEST_WEBHOOK_URL || !TEST_CHANNEL_ID) {
    console.error('TEST_WEBHOOK_URL and TEST_CHANNEL_ID must be set in .env.');
    process.exit(1);
  }
  if (!(await findRunningBot())) {
    console.error("The bot isn't running on this PC - start it first (npm start).");
    process.exit(1);
  }

  const logStart = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0;
  const me = await discord('/users/@me');
  const res = await fetch(`${TEST_WEBHOOK_URL}?wait=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: text, username: 'Link Tester', allowed_mentions: { parse: [] } }),
  });
  if (!res.ok) throw new Error(`Webhook post failed: HTTP ${res.status}`);
  const posted = await res.json();
  console.log(`Posted test message: ${JSON.stringify(text)}`);

  // Wait until the bot has posted and gone quiet for 3 seconds (or give up).
  let botMessages = [];
  let lastChange = Date.now();
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    await sleep(1000);
    const recent = await discord(`/channels/${TEST_CHANNEL_ID}/messages?after=${posted.id}&limit=50`);
    // The bot's own messages, plus posts through its webhook (made "as the sharer").
    const fromBot = recent
      .filter((message) => message.author.id === me.id || (message.webhook_id && message.webhook_id !== posted.webhook_id))
      .reverse();
    if (fromBot.length !== botMessages.length) lastChange = Date.now();
    botMessages = fromBot;
    if (botMessages.length && Date.now() - lastChange > 3000) break;
    if (!botMessages.length && Date.now() - started > 15_000) break;
  }

  if (botMessages.length) {
    // Discord adds its own link previews a few seconds after a message is sent.
    await sleep(6000);
    botMessages = await Promise.all(
      botMessages.map((message) => discord(`/channels/${TEST_CHANNEL_ID}/messages/${message.id}`))
    );
    botMessages = botMessages.filter(Boolean);
  }

  const original = await discord(`/channels/${TEST_CHANNEL_ID}/messages/${posted.id}`);
  console.log(
    botMessages.length === 0
      ? 'The bot did not respond (expected if the message has no links it handles).'
      : `The bot posted ${botMessages.length} message(s); the original was ${original ? 'left in place' : 'deleted'}.`
  );
  botMessages.forEach((message, i) => console.log(describeMessage(message, i, botMessages.length)));

  const newLog = fs.existsSync(LOG_FILE)
    ? fs.readFileSync(LOG_FILE, 'utf8').slice(logStart).trim()
    : '';
  console.log(`\n-- Bot log during the test --\n${newLog || '(nothing logged)'}`);
  process.exit(/ ERROR /.test(newLog) ? 1 : 0);
})().catch((err) => {
  console.error('Live test failed:', err.message);
  process.exit(1);
});
