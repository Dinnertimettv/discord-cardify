# Changelog

## 2.0.0 - September 27, 2026

A ground-up overhaul: every shared post now becomes a clean card built by the
bot, posted in the sharer's name with playable video, and the bot gained Twitch
cards, a link archive, server settings, and a lot of crash-proofing.

### Highlights

- **Post cards for X, TikTok, Instagram, Twitch, and YouTube.** Every post
  becomes the bot's own card - no raw link text - with the author, profile
  picture, text, and **videos that play right in the card**.
- **Clickable headings.** The bold heading at the top of every card
  ("𝕏 · Post", "🎵 TikTok · Video", "📺 Twitch · 🔴 Live", "▶️ YouTube ·
  Video"...) links to the original post. (Discord doesn't let a whole card
  be clickable.)
- **Posted as "Nickname (Embed App)".** Fixed links appear under the sharer's
  current server nickname with "(Embed App)" added, and their profile
  picture, so it's clear the bot posted it for them. Whatever they wrote
  alongside the link comes along.
- **Link archive.** Every shared link is also copied into a thread for its
  category ("X Posts", "TikTok Videos", "Instagram Posts", "YouTube Videos",
  "News Articles"), each one pinned in the archive channel.
- **`/embeds` settings** for server admins: turn the bot off per channel,
  pick the translation language, and choose who posts appear as.

### New

**X cards**
- A bold "𝕏 · Post" heading (or "Replying to @..."), the author's name and
  profile picture, **the post's text in bold**, its photos and videos, and a
  stats bar - replies, reposts, likes, and views in X's short style (10.5K) -
  with "x hours ago" and the app it was posted from.
- **A post that quotes another is one card**, so one card is always one
  shared link. Under the post, a divider and a "↪ Quoting" heading (linked
  to the quoted post) introduce the quoted post: its author's profile
  picture, its text in regular weight set off with a quote line, and its
  photos and videos. An **"Open quoted post"** button sits next to
  "Open on 𝕏". If the quoted post was deleted or made private, a short note
  says so.
- X Community Notes appear in their own amber box under the post.
- Posts not in the server's language get a translation under the original.

**TikTok and Instagram cards**
- TikTok (pink): videos, every slide of photo slideshows, the caption, and
  likes/comments/shares - share links like `vm.tiktok.com/...` included.
- Instagram (magenta): posts, every image of a carousel, and reels.

**Twitch cards** (purple)
- **Clips** play right in the card, with the title, game, views, length, and
  who clipped it.
- **Live channels** show "🔴 Live" with a snapshot of the stream, the title
  and game, viewers, followers, and when the stream started.
- **Past broadcasts** show the thumbnail, views, and length; a link to a
  specific moment (`?t=1h2m3s`) keeps it.
- **Offline channels** show the last stream's title and game, followers, and
  when they were last live.
- Twitch's other pages (the directory, settings, a channel's tabs) are left
  alone. Twitch has no free official feed, so cards come from the data
  twitch.tv's own website uses; if that ever stops working, links go out as
  plain links that Discord previews itself.
- A clip's video link from Twitch lasts about a day, so an old card's clip
  may stop playing - the heading and "Open on Twitch" still lead to it.

**YouTube cards** (red)
- Videos, Shorts, live streams, and premieres: the channel's name, the
  title (a link to the video, like Discord's own YouTube preview), a big
  thumbnail, and views, likes, length, and upload date.
- Two buttons right under the thumbnail: **▶️ Watch on YouTube**, and
  **▶️ Watch on Discord**, which privately shows whoever clicks Discord's
  own YouTube player so the video plays right in Discord. (YouTube doesn't
  hand out video files, so it can't play inside the card itself.)
- A **📺 Watch Together** button: from a voice channel, it privately gives
  you an invite that opens Discord's Watch Together activity there -
  YouTube full-size, in sync for everyone in the call - with the video's
  link to paste in once it opens.
- A **✨ Video Summary** button when YouTube has an AI summary of the video -
  click it to read the summary privately.
- Age-restricted videos arrive blurred. Links to a specific moment
  (`?t=42`) keep it; tracking junk (`?si=...`) is removed.
- Channel pages and playlists are left alone.

**On every card**
- Buttons: **Open on 𝕏 / TikTok / Instagram / Twitch** (YouTube cards have
  their Watch buttons instead), **🔗 Copy link** (privately gives the link,
  ready to copy), **💬 Show top 3 replies** (X), **✨ Video Summary**
  (YouTube), and **🚩 Flag as NSFW**.
- Photos and videos marked sensitive (or from Twitch channels marked
  mature, or age-restricted on YouTube) arrive blurred until clicked.
- **Flag as NSFW** hides the whole card for everyone (moderators or the
  person who shared it only) and swaps in **🔞 Reveal**, which shows the post
  privately to whoever clicks, and **↩️ Undo flag**, which puts the card back
  exactly as it was if it was flagged by mistake (same people as flagging;
  works after restarts too).

**Posting as the sharer**
- Reposts go out through a webhook the bot creates in each channel, as
  "Nickname (Embed App)" with the sharer's profile picture. Works in threads
  too.
- Falls back to posting as the bot automatically wherever a webhook isn't
  possible (DMs, missing permission, or a deleted webhook).

**Link archive**
- Set one archive channel per server in `.env` (`LINK_ARCHIVE_CHANNEL_IDS`,
  comma-separated). It can be the same channel people post links in.
- Each category's thread hangs off a pinned "📌 X Posts"-style message, so
  the channel's pins work as a menu. The bot finds its threads again through
  those pins after restarts, so it never makes duplicates.
- Each copy says who shared it and where, with a jump link back.
- Links from private channels are never copied into an archive everyone can
  see; DMs and test posts are never archived; each server's links only go to
  its own archive.

**`/embeds` command** (needs Manage Server)
- `/embeds channel` - turn link fixing off or on in a channel and its threads.
- `/embeds language` - translate posts into one of 24 languages, or turn
  translation off. English by default.
- `/embeds post-as` - post as the person who shared, or as the bot.
- `/embeds status` - show the current settings and the bot's version.
- Settings are saved in `data/settings.json` and survive restarts.

**Other**
- "Show top 3 replies" threads close (archived and locked, still
  readable) 24 hours after they're opened. Checked every 30 minutes.
- News links: when archive.ph has a snapshot, the post shows the original
  link (with Discord's headline preview) plus an "Archived copy:" link.
- Paywall list expanded from 17 to ~77 major outlets across the US, UK,
  Canada, Australia, Europe, and Asia (CNN, Reuters, Boston Globe, The Verge,
  Der Spiegel, Le Monde, South China Morning Post, and more).

### Changed

- The project is now called **Discord Cardify** (in Discord, the bot goes by
  **Cardify** - Discord doesn't allow "discord" in a bot's name).
- TikTok now uses **tnktok.com** (fxTikTok itself - open source and actively
  maintained) instead of tiktokfix.com. In testing it was the fastest and
  the only reliable option for photo slideshows.
- Links are fetched in parallel, so messages with several links post faster.
- Messages with attachments or stickers are never deleted (those can't be
  reposted) - the bot replies next to them instead.
- Links are cleaned before posting: tracking query strings, trailing
  punctuation, and `<...>` brackets are removed.
- The "Show top 3 replies" button only appears where threads can be made
  (not in DMs or inside threads).

### Fixed

- **Crash:** a link to a deleted or private X post took the whole bot down.
- **Crash protection:** errors in buttons, login, and Discord connection
  problems no longer crash the bot.
- **Double posting:** two copies of the bot could run at once and post every
  link twice. Now only one copy can run per PC (see "For whoever runs the
  bot" below).
- Link previews were hidden when a video post shared a message with a bot
  card - for example, a video post quoting a photo post showed only the quote.
- The link archive silently skipped the channel people post links in.
- archive.ph snapshots were never found (archive.ph shows bots a captcha
  page); the bot now reads archive.ph's redirect instead.
- News headlines showed as just "nytimes.com" when a site blocked the bot.
- Headlines were cut off at apostrophes ("Biden's plan" became "Biden").
- Very long X posts or captions exceeded Discord's limits and failed to post.
- Two posts quoting the same video made Discord reject the whole message.
- Rare race conditions that could create duplicate archive threads.
- Extra spaces left behind where links were removed from someone's text.

### Removed

- Reddit support (Reddit blocks the unauthenticated access it relied on).
- nbcnews.com from the paywall list (it isn't paywalled).

### Security

- **Server allowlist:** list your servers in `ALLOWED_GUILD_IDS` (`.env`) and
  the bot only works there - if anyone adds it to another server, it leaves
  right away and logs it. A mistyped list that matches none of its servers
  makes it warn instead of leaving everywhere.
- **`/embeds` double-checks permissions:** only people with Manage Server can
  change settings, even if a server's Integrations settings let others see
  the command.
- **Settings changes are logged** in `logs/bot.log` with who made them.

### Permissions

The bot needs these in addition to what it had before (Administrator covers
all of them):
- **Manage Webhooks** - to post as the sharer.
- **Pin Messages** - to pin the link archive's category messages.
- **Manage Threads** - to close reply threads after 24 hours.
- **Create Invite** - for YouTube's Watch Together button.
- The **applications.commands** scope - for `/embeds` (re-invite the bot if
  the command doesn't show up in a server).

### For whoever runs the bot

- **Only one copy can run per PC.** A second copy refuses to start and says
  which process to stop. `npm run status` shows whether the bot is running;
  `npm run stop` stops it, wherever it was started from.
- Everything the bot prints is also saved to `logs/bot.log` with timestamps.
- `npm test` runs an offline simulation of Discord (144 checks) - safe, no
  posts.
- `npm run test:live -- "<message>"` posts a real test message into the
  private #bot-testing channel and prints what the bot did with it. Test
  posts are never archived.
- `npm run clean:test` shows the test posts in #bot-testing (the bot's and
  the webhooks'); `npm run clean:test -- --delete` deletes them. People's
  messages and pins are never touched.
- New `.env` settings: `ALLOWED_GUILD_IDS`, `LINK_ARCHIVE_CHANNEL_IDS`,
  `TEST_CHANNEL_ID`, `TEST_WEBHOOK_URL` (see `.env.example`).
- Buttons on messages posted by older versions of the bot keep working.

## 1.0.0

- Original version: reposted X, TikTok, Instagram, Reddit, and paywalled news
  links as fixed links, with reply threads and NSFW flagging.
