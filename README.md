# Discord Cardify

<a href="https://buymeacoffee.com/dinnertime"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me a Coffee" height="40"></a>

X's own link previews on Discord are usually broken (no image, no video, blank
card), TikTok and Instagram links don't preview at all, and paywalled news
links just hit a subscription wall. **Discord Cardify** watches for X/Twitter,
TikTok, Instagram, Twitch, YouTube, and paywalled-news links and replaces the
original message with a clean card — full image galleries, playable video,
stats, and paywall-free articles included.

It also covers what servers usually need several bots for: role panels,
Twitch and YouTube alerts, moderation and auto-mod, a mod log, welcome
messages, leveling, and a music player - see [Server features](#server-features).

(Discord doesn't allow "discord" in a bot's username, so in Discord the bot
goes by **Cardify**.)

**Setting it up for the first time? Start with [SETUP.txt](SETUP.txt)** - a
simple step-by-step guide to setting up and running the bot, no coding
knowledge needed.

## How it works

1. Bot sees a message containing a tweet link.
2. It fetches the post's data from `api.fxtwitter.com`'s v2 API (a free,
   no-key-needed public API — the v2 endpoint specifically, since the older
   legacy one doesn't reliably include quoted-post data).
3. Each X post becomes one card message: a bold **"𝕏 · Post"** heading
   (or "Replying to @…") that links to the original post, the author's
   name, avatar, and the post text (plus a translation if it isn't in the
   server's language - see `/embeds language`). Then its photos and
   **videos, which play right in the card** (**blurred until clicked** when
   X marks the post sensitive), and a **stats bar** - replies, reposts,
   likes, views in X's short style (9.2K) - with "x hours ago" and the app
   it was posted from. X **Community Notes** show in their own amber box
   under the post. An **"Open on 𝕏"** button opens the original post.
4. A post that **quotes** another stays **one card**, so one card is always
   one shared link: the shared post on top, then a divider and a
   **"↪ Quoting"** heading (linked to the quoted post) with the quoted
   post's author and profile picture, its text set off with a quote line,
   and then its photos and videos
   (videos play right in the card). Only one level deep — a quote of a
   quote isn't unwound further. An **"Open
   quoted post"** button sits next to "Open on 𝕏". If the quoted post has
   since been deleted, made private, or suspended, a short note says so.
5. **TikTok** links (videos, photo slideshows, and `vm.tiktok.com` share
   links) become matching pink cards built from **tnktok.com** (fxTikTok):
   author, caption when there is one, the playable video or every slide,
   and likes/comments/shares. Tracking junk (`is_from_webapp` etc.) is
   stripped.
6. **Instagram** posts, carousels, and reels become magenta cards built
   from **instagramfix.com**: author, caption, every image or the reel
   video. Profile links (and anything a card can't be built for) fall back
   to a plain fixer link that Discord previews itself.

   **Twitch** channels, clips, and past broadcasts become purple cards:
   clips play in the card; a live channel shows "🔴 Live" with a snapshot
   of the stream, viewers, and followers; a past broadcast shows its
   thumbnail and length; an offline channel shows its last stream. Twitch
   has no free official feed, so the data comes from the GraphQL API
   twitch.tv's own site uses (unofficial - if it stops working, links fall
   back to plain links Discord previews). A clip's video link lasts about a
   day. Other Twitch pages are left alone, and Twitch links aren't archived.

   **YouTube** videos, Shorts, and streams become red cards: channel name,
   the title as a link to the video, a big thumbnail, and views, likes,
   length, and upload date - read from the video's public watch page, with
   YouTube's official oEmbed feed as a fallback. Under the thumbnail are
   **"▶️ Watch on YouTube"** and **"▶️ Watch on Discord"** buttons. YouTube
   doesn't hand out video files, so the video can't play inside the card;
   Watch on Discord privately sends whoever clicks the plain link, where
   Discord shows its own playable YouTube player. (A card's picture can't be
   a link - Discord opens its picture viewer when it's clicked.) A
   **"📺 Watch Together"** button, clicked from a voice channel, privately
   gives an invite that opens Discord's Watch Together activity there
   (YouTube full-size, in sync for everyone in the call) plus the video's
   link to paste in - Discord doesn't let bots pick the video. When YouTube
   has an AI summary of the video, a **"✨ Video Summary"** button shows it
   privately. Channel pages and playlists are left alone.
7. For links to **paywalled news sites** (~75 major outlets - see
   `DEFAULT_PAYWALL_DOMAINS` in `index.js`, or override with `PAYWALL_DOMAINS`),
   the bot checks archive.ph for an existing snapshot of that exact
   article - this is the only check it can actually verify, since it's a
   real HTTP redirect. If a snapshot is found, it posts that direct
   archived link. **If none is found**, it posts the article's title
   (pulled from the page's own tags), the original link (still gets
   Discord's own preview card), and a clearly labeled, unverified bypass
   attempt link - so the reader can judge for themselves rather than the
   bot guessing on their behalf.
8. It reposts the fixed version **as "Nickname (Embed App)" with the
   sharer's avatar** - their current server nickname, marked so it's clear
   the bot posted it, not the person (through a webhook - Discord also
   shows a small "APP" tag). Any text
   they wrote alongside the links, then **deletes** their original message
   so the channel only shows the clean version. This needs the **Manage
   Messages** and **Manage Webhooks** permissions. A server can switch to
   posting as the bot instead ("@Username shared:" with their text quoted)
   with `/embeds post-as`, and the bot does that automatically wherever it
   can't use a webhook. Messages with attachments or stickers are never
   deleted (those can't be reposted) - the bot replies instead.
9. If any linked post has replies, a **"Show top 3 replies"** button appears
   under the message. Clicking it fetches the 3 most-liked replies via
   fxtwitter's conversation API and posts them into a thread on that
   message (creating the thread if one doesn't exist yet). The button then
   disables itself so it can't post duplicates. Reply threads close
   (archived and locked, still readable) 24 hours after they're opened.
   This needs the **Create Public Threads** and **Manage Threads**
   permissions, and only appears in regular text and announcement
   channels - threads can't be started in DMs or inside another thread.
10. Every reposted post gets a **"🔗 Copy link"** button. Discord doesn't
    let bots put anything on your clipboard, so it privately replies with
    just the fixed link(s) (no preview) - long-press (mobile) or right-click
    (desktop) the link to copy it. On X post cards it gives the post's
    fxtwitter link, which isn't otherwise shown.
11. Every card gets a **"Flag as NSFW"** button. Moderators (or whoever
    shared the link) can use it to hide the post for everyone; it's replaced
    with a **"Reveal"** button that shows the post privately to whoever
    clicks it, and an **"↩️ Undo flag"** button (same people) that puts the
    card back exactly as it was. Flagged cards are saved in
    `data/flagged.json` for that (the 500 most recent), so Undo works after
    restarts.
12. **Link archive (optional):** every shared X, TikTok, Instagram, YouTube,
    and news link is also copied into a thread for its category - "X Posts",
    "TikTok Videos", "Instagram Posts", "YouTube Videos", "News Articles" -
    in a channel you choose (`LINK_ARCHIVE_CHANNEL_IDS`, one channel per
    server - each server's links only ever go to its own channel; it can be
    the same channel people post links in). Each copy
    says who shared it and where, with a jump link back. Each category's
    thread hangs off a pinned "📌 X Posts"-style message the bot posts when it
    starts, so the channel's pins work as a menu of the categories (this
    needs the **Pin Messages** permission). The bot finds its threads again
    through those pins after restarts, so it never creates duplicates. Links from
    private channels are never copied into an archive everyone can see, and
    DMs are never copied.
13. **`/embeds` (for server admins - needs Manage Server):**
    - `/embeds channel enabled:False` - stop fixing links in the current
      channel and its threads (`True` turns it back on)
    - `/embeds language` - the language posts get translated into, or off
    - `/embeds post-as` - post as the person who shared, or as the bot
    - `/embeds status` - show the current settings

    Settings are saved in `data/settings.json`.
14. If Manage Messages is ever missing (or the bot is in a DM, where there's
    no Manage Messages concept at all), it falls back to replying next to
    the original message instead of deleting anything.

The bot works the same way in DMs as in servers, with that one difference:
DMs always use the reply-and-suppress path since deleting someone else's
message isn't possible there. `DirectMessages` isn't a privileged intent,
so no extra Developer Portal toggle is needed for it - just make sure
whoever wants to DM the bot shares a server with it and hasn't disabled DMs
from server members.

No scraping, API keys, or Twitter developer account needed — `fxtwitter.com`
handles that part for you.

### About the paywall-skip verification

**Why unverified links are always labeled, never guessed silently:**
removepaywall.com and paywallskip.com both build their actual result
*client-side* with JavaScript - a plain server-side fetch (all a bot can
do) just gets an empty page shell back, not the article or any clean
success/failure signal. There's no way to confirm one of these actually
found the article before posting it. (Confirmed directly: fetching
`removepaywall.com/search?url=...` returns a page offering four manual
buttons to click through, not a resolved article - two of which point at
`archive.is`, the same service archive.ph checks.)

archive.ph is different: looking up `archive.ph/newest/<url>` is a real
HTTP redirect, so the bot can actually tell whether a snapshot was found.
That's why it's the only *verified* method - when it finds a snapshot,
that's the only link posted. When it doesn't, rather than picking one
option to guess with, the bot shows the article title, the original link,
and the unverified bypass attempt side by side and lets the reader decide.

Caveats worth knowing about archive.ph itself:

- It's blocked by some ISPs and countries, and has an ongoing DNS dispute
  with Cloudflare's `1.1.1.1` resolver, so a small share of readers may not
  be able to open the link even when the bot found one successfully.
- It can be slow (sometimes minutes) or time out during busy periods -
  the bot caps its wait at `ARCHIVE_PH_TIMEOUT_MS` (8 seconds by default)
  and falls back to the title/original/bypass block rather than hang.
- It only checks for an *existing* snapshot. If nobody has archived that
  exact article yet, there's nothing to find - the bot doesn't attempt to
  trigger a new archive.ph capture, since that process is slow and can
  require solving a captcha, which isn't something to do inline while
  handling a Discord message.
- The "was a snapshot found" detection is a best-effort heuristic, since
  archive.ph doesn't publish its response formats. If you notice it
  missing snapshots you know exist, let me know what you're seeing.

The article title is pulled from the page's own `og:title` or `<title>`
tag with a plain fetch - most paywalled sites still serve their headline
for social-sharing purposes even though the body text is blocked. If a
site doesn't expose either tag, the fallback just skips the title line.

### Customizing

- `FIX_DOMAIN` in `.env` controls the fallback link domain for video tweets
  (`fxtwitter.com` or `vxtwitter.com`).
- `TIKTOK_FIX_DOMAIN` controls the TikTok fixer domain.
- `PAYWALL_DOMAINS` controls which news sites get routed through the
  paywall bypass, and `PAYWALL_FIX_URL` controls which bypass service is
  used. See the Configuration table below.
- All embeds use a single fixed color (`EMBED_COLOR` near the top of
  `index.js`, black by default) - the v2 API doesn't expose a per-author
  palette color to pull from instead.

## Server features

Every feature is set up with slash commands. The setup commands are hidden
from members who lack the permission they need, and the bot checks that
permission again each time.

**New server? Run `/setup`.** It's a short step-by-step guide made of menus
(pick an answer and it's saved right away): which features to turn on, where
the bot posts (mod log, welcome, goodbye, level-ups), which channels it works
in or stays quiet in, which roles can use music, levels and link cards, and
which voice channels music can join.

**`/help`** (or typing **`!help`**) shows a friendly guide: what each
feature does, how to start, and every command and option - plus whether
it's on, and who can use it, in this server.

**`/access`** controls who can use what, and where, for a whole feature or
a single command:

- `/access feature` - turn a feature on or off
- `/access add-role` / `remove-role` - only some roles can use it
- `/access add-channel` / `remove-channel` - it only works in some channels
- `/access quiet-channel` - the bot ignores a channel completely (no link
  cards, no XP, no commands)
- `/access reset` and `/access view`

People with Manage Server can always use every command (channel limits
still count for them), and `/help`, `/setup` and `/access` always work, so
nobody gets locked out. Role and channel limits on link cards and levels
decide whose links get cards and who earns XP.

| Command | Who | What it does |
|---|---|---|
| `/roles` | Manage Roles | Role panels: members pick roles with **buttons**, a **dropdown**, or **emoji reactions** (optionally one at a time). Never hands out moderator-level roles, bot roles, or roles above the bot's own. |
| `/emoji add`, `/sound add` | Create Expressions | Add an emoji (upload, link, or copy another server's) or a soundboard sound. |
| `/alerts` | Manage Server | Post when a Twitch streamer goes live or a YouTube channel uploads, with an optional role ping. |
| `/mod` | Timeout / Kick / Ban Members, Manage Messages | `warn`, `warnings`, `timeout`, `kick`, `ban`, `unban`, `purge` - never on the owner, the bot, or anyone with an equal or higher role. |
| `/automod` | Manage Server | Sets up Discord's own AutoMod: blocked words, invite links, spam, mention limits, profanity lists. |
| `/logs` | Manage Server | A mod log channel: deleted and edited messages, bans, joins and leaves, every `/mod` action. |
| `/welcome` | Manage Server | Welcome and goodbye messages, and a role every new member gets. |
| `/rank`, `/leaderboard`, `/levels` | everyone / Manage Server | Leveling: XP for chatting (once a minute), random level-up messages (jokes for the first levels, big cheers for high ones - add your own with `/levels add-message`), and roles as rewards. Off until `/levels on`. |
| `/play`, `/radio`, `/music` | everyone | A music player for voice channels: search for a song by name, YouTube links and playlists, Spotify songs, albums and playlists (each song is found on YouTube Music), uploaded files, direct audio links, internet radio (searchable), and the sound of X / TikTok / Instagram / Twitch clips. Queue, skip, pause, volume, loop, shuffle, plus buttons on the "Now playing" card. |
| `/music-setup` | Manage Server | A DJ role, which voice channels music can join, the starting volume, the queue limit, and 24/7 mode. |
| `/setup`, `/access` | Manage Server | The setup guide, and who can use what, and where (see above). |
| `/help`, `!help` | everyone | What every feature and command does. |

Settings are saved in the `data/` folder. Welcome messages, auto-roles, and
join/leave logs need the **Server Members Intent** (below); the bot checks
for it at startup and works without it.

## Setup

### 1. Create the bot application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. Go to **Bot** → **Add Bot**.
3. Under **Privileged Gateway Intents**, enable **Message Content Intent**
   (and **Server Members Intent** if you want welcome messages, auto-roles,
   and join/leave logs).
4. Click **Reset Token** and copy it — you'll need it for `.env`.

### 2. Invite it to your server

In **OAuth2 → URL Generator**:

- Scopes: `bot`, `applications.commands` (for the `/embeds` command)
- Bot Permissions: `View Channels`, `Send Messages`, `Read Message History`, `Manage Messages`, `Embed Links`, `Create Public Threads`, `Send Messages in Threads`, `Manage Threads`, `Pin Messages`, `Manage Webhooks`, `Create Invite`, `Use Application Commands`
- For the server features: `Manage Roles`, `Create Expressions`, `Add Reactions`, `Timeout Members`, `Kick Members`, `Ban Members`, `Manage Server` (for AutoMod), `Connect`, `Speak` - or just `Administrator`

Open the generated URL and add the bot to your server. Then, in the
Developer Portal under **Bot**, turn off **Public Bot** so only you can add
it to servers, and set `ALLOWED_GUILD_IDS` (below) so it leaves any server
it's added to anyway. `/embeds` only works for people with **Manage
Server** (the bot checks, whatever the server's Integrations settings say),
and every settings change is logged with who made it. If the bot is
*already* in your server from an earlier setup, you don't need to
re-invite it — go to **Server Settings → Roles**, find the bot's
auto-created role, and toggle on any new permissions there instead.

### 3. Install and run

Requires Node.js 22.12 or newer. `npm install` also downloads ffmpeg
(about 80 MB) for the music player. The first time the bot starts, it
downloads [yt-dlp](https://github.com/yt-dlp/yt-dlp) (about 17 MB, into
`bin/`) for YouTube and Spotify songs, and lets it update itself once a day,
since YouTube changes often. Playing YouTube audio in a bot is against
YouTube's terms of service - this bot is meant for private servers.

```bash
npm install
cp .env.example .env
# paste your bot token into .env
npm start
```

## Configuration

Set in `.env`:

| Variable        | Description                                              | Default          |
|-----------------|------------------------------------------------------------|-------------------|
| `DISCORD_TOKEN` | Your bot's token from the Developer Portal                | *(required)*      |
| `ALLOWED_GUILD_IDS` | Comma-separated server IDs the bot works in (recommended). If it's added to any other server it leaves right away. If none of its servers match (a typo), it warns instead of leaving. Right-click a server icon → **Copy Server ID** (Developer Mode on) | *(any server)* |
| `LINK_ARCHIVE_CHANNEL_IDS` | Comma-separated channel IDs where links get copied into category threads - one per server. Turn on Developer Mode (Settings → Advanced), then right-click the channel → **Copy Channel ID**. Restart the bot after changing it | *(off)* |
| `FIX_DOMAIN`    | `fxtwitter.com` or `vxtwitter.com` — both work similarly   | `fxtwitter.com`   |
| `TIKTOK_FIX_DOMAIN` | Domain used to make TikTok links playable (`a.tnktok.com` adds captions) | `tnktok.com` |
| `INSTAGRAM_FIX_DOMAIN` | Domain used to make Instagram links embed         | `instagramfix.com` |
| `PAYWALL_DOMAINS` | Comma-separated list of news domains to route through the bypass. **Replaces** the built-in list rather than adding to it | `DEFAULT_PAYWALL_DOMAINS` in `index.js` |
| `PAYWALL_FIX_URL` | Prefix for the unverified bypass-attempt link shown when no archive.ph snapshot is found | `https://www.removepaywall.com/search?url=` |
| `ARCHIVE_PH_ENABLED` | Try archive.ph for a verified existing snapshot   | `true` |
| `ARCHIVE_PH_TIMEOUT_MS` | Max time to wait on an archive.ph lookup before giving up | `8000` |

## Running and testing

- Only one copy of the bot can run at a time on a PC (it refuses to start a
  second, since two copies would double-post). `npm run status` shows
  whether it's running, and `npm run stop` stops it - even a copy running
  in the background with no window. Output is also written to
  `logs/bot.log` with timestamps.
- `npm test` runs an offline simulation of Discord - quick, safe, no posts.
- `npm run test:live -- "some text https://x.com/..."` posts a real test
  message into the private #bot-testing channel (through the webhook in
  `TEST_WEBHOOK_URL`) and prints what the running bot did with it. Test posts
  are never copied into the link archive.
- `npm run clean:test` lists the test posts piling up in #bot-testing (the
  bot's posts and anything posted through webhooks); `npm run clean:test --
  --delete` deletes them. People's messages and pins are never touched.

## Notes

- Works for any number of tweet links in a single message.
- If the bot lacks Manage Messages permission, it still posts the fixed
  link — it just won't be able to hide the original broken embed.
- To run this continuously, host it on a small VPS or a process manager
  like `pm2` (`pm2 start index.js --name cardify`).

## License

[MIT](LICENSE) - free to use, change, and share, as long as the copyright
notice stays with it.

If Discord Cardify makes your server better, you can
[buy me a coffee](https://buymeacoffee.com/dinnertime) ☕ - thank you!
