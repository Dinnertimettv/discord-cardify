// Music: plays audio in voice channels - songs from YouTube (by link or by
// searching), Spotify songs, albums and playlists (each song is found on
// YouTube Music when it's its turn), uploaded files, direct audio links,
// internet radio (from the radio-browser.info directory), and the sound of X,
// TikTok, Instagram and Twitch clips. YouTube audio comes through yt-dlp
// (ytdlp.js); ffmpeg (from ffmpeg-static) decodes everything; @discordjs/voice
// sends it to Discord.
// Admins set it up with /music-setup (saved in data/music.json); the queue
// itself only lives in memory.
const dns = require('dns');
const net = require('net');
const { spawn } = require('child_process');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ContainerBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextDisplayBuilder,
  escapeMarkdown,
} = require('discord.js');
const { createStore } = require('../store');
const ytdlp = require('../ytdlp');
const tempVoice = require('./tempvoice');

const store = createStore('music.json', { guilds: {} });

const MUSIC_COLOR = 0x9b59b6;
// voiceChannels: the voice channels music may join (empty: any).
// voiceChatOnly: music commands only work in the chat of the voice channel
// the music is in (every voice channel has its own chat), so the commands and
// the "Now playing" card stay with the people listening.
const DEFAULTS = { djRoleId: null, voiceChannels: [], volume: 60, maxQueue: 100, stay: false, voiceChatOnly: true };
const MAX_VOLUME = 150;
// Leave the voice channel this long after the queue runs out, or after everyone else leaves.
const IDLE_LEAVE_MS = 3 * 60_000;
const ALONE_LEAVE_MS = 2 * 60_000;
const RADIO_API = 'https://de1.api.radio-browser.info/json';
const USER_AGENT = 'Cardify Discord bot';
const AUDIO_EXTENSIONS = /\.(mp3|ogg|oga|opus|wav|flac|m4a|aac|webm|mp4|mov|mkv)$/i;
const YOUTUBE_HOSTS = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i;
const SPOTIFY_HOSTS = /(^|\.)(spotify\.com|spotify\.link)$/i;
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const PLAYLIST_TYPES = new Set(['audio/x-mpegurl', 'audio/mpegurl', 'application/x-mpegurl', 'application/vnd.apple.mpegurl', 'audio/x-scpls', 'application/pls+xml']);

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const PLAY_COMMAND = new SlashCommandBuilder()
  .setName('play')
  .setDescription('Play a song: search by name, or use a YouTube, Spotify, audio or clip link (or a file)')
  .setContexts(InteractionContextType.Guild)
  .addStringOption((o) => o.setName('song').setDescription('A song name to search for, or a YouTube, Spotify, audio, radio or clip link'))
  .addAttachmentOption((o) => o.setName('file').setDescription('An audio (or video) file to play'));

const RADIO_COMMAND = new SlashCommandBuilder()
  .setName('radio')
  .setDescription('Play an internet radio station')
  .setContexts(InteractionContextType.Guild)
  .addStringOption((o) => o.setName('station').setDescription('Search by name, genre or country').setRequired(true).setAutocomplete(true).setMaxLength(100));

const MUSIC_COMMAND = new SlashCommandBuilder()
  .setName('music')
  .setDescription('Control the music')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) => s.setName('queue').setDescription("See what's playing and what's next"))
  .addSubcommand((s) => s.setName('skip').setDescription('Skip the current song'))
  .addSubcommand((s) => s.setName('pause').setDescription('Pause the music'))
  .addSubcommand((s) => s.setName('resume').setDescription('Resume the music'))
  .addSubcommand((s) => s.setName('stop').setDescription('Stop, clear the queue, and leave the voice channel'))
  .addSubcommand((s) =>
    s
      .setName('volume')
      .setDescription('Set the volume')
      .addIntegerOption((o) => o.setName('percent').setDescription(`1-${MAX_VOLUME}`).setRequired(true).setMinValue(1).setMaxValue(MAX_VOLUME))
  )
  .addSubcommand((s) =>
    s
      .setName('remove')
      .setDescription('Remove a song from the queue')
      .addIntegerOption((o) => o.setName('position').setDescription('Its number in /music queue').setRequired(true).setMinValue(1))
  )
  .addSubcommand((s) => s.setName('shuffle').setDescription('Shuffle the queue'))
  .addSubcommand((s) =>
    s
      .setName('loop')
      .setDescription('Repeat the current song or the whole queue')
      .addStringOption((o) =>
        o
          .setName('mode')
          .setDescription('What to repeat')
          .setRequired(true)
          .addChoices({ name: 'Off', value: 'off' }, { name: 'This song', value: 'track' }, { name: 'The whole queue', value: 'queue' })
      )
  );

const SETUP_COMMAND = new SlashCommandBuilder()
  .setName('music-setup')
  .setDescription('Set up the music player')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) =>
    s
      .setName('dj-role')
      .setDescription("Only this role can skip others' songs, stop, or change the volume (empty: everyone)")
      .addRoleOption((o) => o.setName('role').setDescription('The DJ role'))
  )
  .addSubcommand((s) =>
    s
      .setName('voice-channel')
      .setDescription('Choose which voice channels I can play music in (with none chosen: any)')
      .addChannelOption((o) => o.setName('channel').setDescription('A voice channel').setRequired(true).addChannelTypes(ChannelType.GuildVoice))
      .addBooleanOption((o) => o.setName('allowed').setDescription('Can I play music there?').setRequired(true))
  )
  .addSubcommand((s) =>
    s
      .setName('voice-chat-only')
      .setDescription("Only take music commands in the chat of the music's voice channel")
      .addBooleanOption((o) => o.setName('on').setDescription('On (recommended), or off to allow any text channel').setRequired(true))
  )
  .addSubcommand((s) =>
    s
      .setName('volume')
      .setDescription('The volume the music starts at')
      .addIntegerOption((o) => o.setName('percent').setDescription(`1-${MAX_VOLUME}`).setRequired(true).setMinValue(1).setMaxValue(MAX_VOLUME))
  )
  .addSubcommand((s) =>
    s
      .setName('queue-limit')
      .setDescription('The most songs the queue can hold')
      .addIntegerOption((o) => o.setName('songs').setDescription('1-500').setRequired(true).setMinValue(1).setMaxValue(500))
  )
  .addSubcommand((s) =>
    s
      .setName('stay')
      .setDescription('Stay in the voice channel when the music ends or everyone leaves (24/7)')
      .addBooleanOption((o) => o.setName('on').setDescription('On or off').setRequired(true))
  )
  .addSubcommand((s) => s.setName('status').setDescription('See the music settings'));

// ---------------------------------------------------------------------------
// Voice and audio - kept in one object so the tests can swap them out
// ---------------------------------------------------------------------------

let voice; // @discordjs/voice, loaded on first use
const loadVoice = () => (voice ??= require('@discordjs/voice'));

const engine = {
  join(channel) {
    return loadVoice().joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
      // Joining muted (the library's default) would mean nobody hears it.
      selfMute: false,
    });
  },
  async ready(connection) {
    const { entersState, VoiceConnectionStatus } = loadVoice();
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    // Moved to another channel or a voice server change: give it a moment to
    // reconnect; otherwise (kicked, channel deleted) it's over.
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]).catch(() => {
        if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
      });
    });
  },
  createPlayer() {
    const { createAudioPlayer, NoSubscriberBehavior } = loadVoice();
    return createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  },
  // ffmpeg turns any link into raw audio. Only web protocols are allowed, so a
  // playlist can't point it at files on this PC. YouTube (and Spotify songs,
  // found on YouTube Music) come from yt-dlp through a pipe instead.
  createResource(track, volume) {
    const { createAudioResource, StreamType } = loadVoice();
    const input = track.ytdlp
      ? ['-protocol_whitelist', 'pipe', '-i', 'pipe:0']
      : [
          '-nostdin',
          '-protocol_whitelist', 'http,https,tcp,tls,crypto,hls',
          '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
          '-user_agent', USER_AGENT,
          '-i', track.url,
        ];
    const ffmpeg = spawn(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', ...input, '-vn', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'], {
      stdio: [track.ytdlp ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    track.errors = '';
    const note = (chunk) => {
      if (track.errors.length < 2000) track.errors += chunk;
    };
    ffmpeg.stderr.on('data', note);
    ffmpeg.on('error', (err) => note(err.message));
    ffmpeg.stdout.on('error', () => {});
    let downloader = null;
    if (track.ytdlp) {
      downloader = ytdlp.stream(track.ytdlp);
      downloader.stderr.on('data', note);
      downloader.on('error', (err) => note(err.message));
      downloader.stdout.on('error', () => {});
      ffmpeg.stdin.on('error', () => {});
      downloader.stdout.pipe(ffmpeg.stdin);
    }
    const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw, inlineVolume: true, metadata: track });
    resource.volume.setVolume(volume / 100);
    return {
      resource,
      stop: () => {
        downloader?.kill();
        ffmpeg.kill();
      },
    };
  },
  // A YouTube search or playlist: { title, entries: [{ id, title, duration, live }] }
  youtubeList: (url, options) => ytdlp.list(url, options),
  lookup: (host) => dns.promises.lookup(host, { all: true }),
};

let client = null;
let request = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(options.timeoutMs ?? 10_000) });
let clipAudioFor = async () => null;
// A YouTube video's title, length, and whether it's live or age-restricted (index.js reads the watch page).
let youtubeVideo = async () => null;

function init(deps) {
  ({ client } = deps);
  if (deps.request) request = deps.request;
  if (deps.clipAudioFor) clipAudioFor = deps.clipAudioFor;
  if (deps.youtubeVideo) youtubeVideo = deps.youtubeVideo;
}

function settingsFor(guildId) {
  const guilds = store.load().guilds;
  guilds[guildId] = { ...DEFAULTS, ...guilds[guildId] };
  guilds[guildId].voiceChannels = [...guilds[guildId].voiceChannels];
  return guilds[guildId];
}

// ---------------------------------------------------------------------------
// Finding what to play
// ---------------------------------------------------------------------------

function isPrivateAddress(ip) {
  const v4 = ip.match(/^(?:::ffff:)?(\d+)\.(\d+)\.\d+\.\d+$/i);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  return v6 === '::' || v6 === '::1' || /^(?:fc|fd|fe[89ab])/.test(v6) || v6.startsWith('::ffff:');
}

// Only links to the public internet - never this PC or its home network,
// which the bot can reach but nobody in Discord should be able to point it at.
async function isPublicLink(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || /\.(?:localhost|local|internal|lan|home)$/.test(host)) return false;
  if (!host.includes('.') && !host.includes(':')) return false;
  const addresses = net.isIP(host) ? [host] : (await engine.lookup(host).catch(() => [])).map((entry) => entry.address);
  return addresses.length > 0 && !addresses.some(isPrivateAddress);
}

const fileTitle = (name) => decodeURIComponent(name.replace(/\.[^.]+$/, '')).replace(/[_]+/g, ' ').trim() || 'Audio';
const linkTitle = (url) => fileTitle(new URL(url).pathname.split('/').filter(Boolean).pop() ?? new URL(url).hostname);

// A playlist file (.m3u / .pls, which many radio sites link to) -> its first stream.
function firstPlaylistEntry(body) {
  const pls = body.match(/^File\d+=(\S+)/im)?.[1];
  if (pls) return pls;
  return body.split(/\r?\n/).map((line) => line.trim()).find((line) => /^https?:\/\//i.test(line)) ?? null;
}

// What /play was given -> { tracks, from } (from: the playlist or album's
// name), or { problem } saying why it can't play.
async function findTracks(input) {
  const link = asLink(input);
  if (!link) return searchYouTube(input);
  if (YOUTUBE_HOSTS.test(link.hostname)) return fromYouTube(link);
  if (SPOTIFY_HOSTS.test(link.hostname)) return fromSpotify(link);
  const track = await trackFromLink(link.href);
  return track.problem ? track : { tracks: [track] };
}

// A link, even without https:// ("youtu.be/...") or as a spotify:track:... code. Anything else is a search.
function asLink(input) {
  const text = input.trim();
  const spotifyCode = text.match(/^spotify:(track|album|playlist|episode|show|artist):([A-Za-z0-9]+)$/i);
  if (spotifyCode) return new URL(`https://open.spotify.com/${spotifyCode[1].toLowerCase()}/${spotifyCode[2]}`);
  if (/\s/.test(text)) return null;
  const withScheme = /^https?:\/\//i.test(text) ? text : /^[\w-]+(\.[\w-]+)+\//.test(text) ? `https://${text}` : null;
  try {
    return withScheme ? new URL(withScheme) : null;
  } catch {
    return null;
  }
}

const watchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;
const youtubeTrack = ({ id, title, duration, live }) => ({
  kind: 'youtube',
  ytdlp: watchUrl(id),
  url: watchUrl(id),
  link: watchUrl(id),
  title: title || 'YouTube video',
  duration: duration ?? null,
  live: Boolean(live),
});

async function searchYouTube(query) {
  try {
    const { entries } = await engine.youtubeList(`ytsearch1:${query}`, { limit: 1 });
    return entries.length ? { tracks: [youtubeTrack(entries[0])] } : { problem: `I couldn't find "${query}" on YouTube.` };
  } catch (err) {
    console.error('Music: YouTube search failed:', err.message);
    return { problem: "Couldn't search YouTube right now - try again in a moment." };
  }
}

function youtubeVideoId(link) {
  const [first, second] = link.pathname.split('/').filter(Boolean);
  const id = /(^|\.)youtu\.be$/i.test(link.hostname) ? first : first === 'watch' ? link.searchParams.get('v') : ['shorts', 'live', 'embed', 'v'].includes(first) ? second : null;
  return /^[\w-]{11}$/.test(id ?? '') ? id : null;
}

// A video plays by itself (even from inside a playlist); a playlist link queues the playlist.
async function fromYouTube(link) {
  const videoId = youtubeVideoId(link);
  const listId = link.searchParams.get('list');
  if (!videoId && listId && /^[\w-]+$/.test(listId)) {
    try {
      const playlist = await engine.youtubeList(`https://www.youtube.com/playlist?list=${listId}`, { limit: 100 });
      if (!playlist.entries.length) return { problem: 'That playlist is empty, or private.' };
      return { tracks: playlist.entries.map(youtubeTrack), from: playlist.title };
    } catch (err) {
      console.error(`Music: couldn't open YouTube playlist ${listId}:`, err.message);
      return { problem: "Couldn't open that playlist - it may be private." };
    }
  }
  if (!videoId) return { problem: "That YouTube link doesn't go to a video or a playlist." };
  const info = await youtubeVideo(videoId).catch(() => null);
  if (info?.ageRestricted) return { problem: "That video is age-restricted, so YouTube won't let me play it." };
  return { tracks: [youtubeTrack({ id: videoId, title: info?.title, duration: info?.seconds, live: info?.live })] };
}

// Spotify's own audio is locked, so each song is looked up on YouTube Music
// when it's its turn to play. Names and lengths come from Spotify's public
// embed page - no Spotify account needed.
async function fromSpotify(link) {
  let url = link;
  if (/(^|\.)spotify\.link$/i.test(link.hostname)) {
    // Short links redirect to the real one.
    const res = await request(link.href, { timeoutMs: 8000, headers: { 'User-Agent': BROWSER_USER_AGENT } }).catch(() => null);
    res?.body?.cancel().catch(() => {});
    url = res?.url ? new URL(res.url) : null;
  }
  const match = url?.pathname.match(/\/(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]{22})/);
  if (!match || !/(^|\.)spotify\.com$/i.test(url.hostname)) return { problem: "That doesn't look like a Spotify song, album or playlist link." };
  const [, type, id] = match;
  if (!['track', 'album', 'playlist'].includes(type)) return { problem: 'I can play Spotify songs, albums and playlists - not podcasts or artist pages.' };
  let entity = null;
  try {
    const res = await request(`https://open.spotify.com/embed/${type}/${id}`, { timeoutMs: 10_000, headers: { 'User-Agent': BROWSER_USER_AGENT, 'Accept-Language': 'en' } });
    const html = res.ok ? await res.text() : '';
    const data = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s)?.[1];
    entity = data ? JSON.parse(data).props?.pageProps?.state?.data?.entity : null;
  } catch (err) {
    console.error(`Music: couldn't read Spotify ${type} ${id}:`, err.message);
  }
  if (!entity) return { problem: "Couldn't open that on Spotify - it may be private or deleted." };
  const songs =
    type === 'track'
      ? [{ name: entity.name, artists: (entity.artists ?? []).map((artist) => artist.name).join(', '), duration: entity.duration, id }]
      : (entity.trackList ?? []).map((song) => ({ name: song.title, artists: song.subtitle ?? '', duration: song.duration, id: song.uri?.split(':').pop() }));
  const tracks = songs.filter((song) => song.name).map(spotifyTrack);
  if (!tracks.length) return { problem: "That Spotify list doesn't have any songs I can play." };
  return { tracks, from: type === 'track' ? null : entity.name };
}

function spotifyTrack({ name, artists, duration, id }) {
  const by = String(artists).replace(/\s+/g, ' ').trim();
  const search = `https://music.youtube.com/search?q=${encodeURIComponent(`${by} ${name}`.trim())}#songs`;
  return {
    kind: 'spotify',
    ytdlp: search,
    url: search,
    link: /^[A-Za-z0-9]{22}$/.test(id ?? '') ? `https://open.spotify.com/track/${id}` : null,
    title: by ? `${by} - ${name}` : name,
    duration: duration ? Math.round(duration / 1000) : null,
  };
}

// A direct link, a radio stream, a playlist file, or a clip -> a track, or { problem }.
async function trackFromLink(link) {
  const url = new URL(link);

  const clip = await clipAudioFor(link).catch((err) => {
    console.error(`Music: couldn't get the video behind ${link}:`, err.message);
    return { failed: true };
  });
  if (clip?.failed) return { problem: "Couldn't load that post - it may be deleted or private." };
  if (clip) return { url: clip.url, title: clip.title, link: clip.link, kind: 'clip' };
  if (/(^|\.)twitch\.tv$/i.test(url.hostname)) return { problem: 'I can only play Twitch clips - not live streams or past broadcasts.' };
  if (/(^|\.)(x|twitter|tiktok|instagram)\.com$/i.test(url.hostname)) return { problem: 'That post has no video to play.' };

  if (!(await isPublicLink(url.href))) return { problem: "I can only play links to public websites." };
  let res;
  try {
    res = await request(url.href, { timeoutMs: 10_000, headers: { 'User-Agent': USER_AGENT, 'Icy-MetaData': '0' } });
  } catch {
    // Some old radio servers answer in a way fetch can't read, but ffmpeg can.
    return { url: url.href, title: linkTitle(url.href), link: url.href, kind: 'link' };
  }
  const finalUrl = res.url || url.href;
  if (!res.ok) {
    res.body?.cancel().catch(() => {});
    return { problem: `That link didn't work (error ${res.status}).` };
  }
  if (finalUrl !== url.href && !(await isPublicLink(finalUrl))) {
    res.body?.cancel().catch(() => {});
    return { problem: 'I can only play links to public websites.' };
  }
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const isPlaylist = PLAYLIST_TYPES.has(type) || /\.(m3u8?|pls)$/i.test(new URL(finalUrl).pathname);
  if (isPlaylist) {
    const body = (await res.text().catch(() => '')).slice(0, 50_000);
    // HLS streams (#EXT-X-...) go to ffmpeg as they are; plain playlists name the real stream.
    if (!body.includes('#EXT-X-')) {
      const entry = firstPlaylistEntry(body);
      if (!entry || !(await isPublicLink(entry))) return { problem: "Couldn't find a stream in that playlist." };
      return { url: entry, title: linkTitle(finalUrl), link: url.href, kind: 'link', live: true };
    }
    return { url: finalUrl, title: linkTitle(finalUrl), link: url.href, kind: 'link' };
  }
  res.body?.cancel().catch(() => {});
  const live = Boolean(res.headers.get('icy-name') || res.headers.get('icy-br'));
  if (type.startsWith('text/') || type.includes('html') || type.includes('json') || type.startsWith('image/')) {
    return { problem: "That link is a web page, not audio. Use a direct link to an audio file or stream - or `/radio` for radio stations." };
  }
  const title = res.headers.get('icy-name')?.trim() || linkTitle(finalUrl);
  return { url: finalUrl, title, link: url.href, kind: 'link', live };
}

function trackFromFile(file) {
  const type = (file.contentType ?? '').toLowerCase();
  if (!type.startsWith('audio/') && !type.startsWith('video/') && !AUDIO_EXTENSIONS.test(file.name ?? '')) {
    return { problem: 'That file isn\'t audio or video. Upload an MP3, OGG, WAV, FLAC, M4A, or a video file.' };
  }
  return { url: file.url, title: fileTitle(file.name ?? 'Audio'), link: null, kind: 'file' };
}

// radio-browser.info: a free, community-kept directory of radio streams.
async function searchStations(query, limit = 10) {
  const params = new URLSearchParams({ name: query, limit: String(limit), hidebroken: 'true', order: 'clickcount', reverse: 'true' });
  const res = await request(`${RADIO_API}/stations/search?${params}`, { timeoutMs: 2500, headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).filter((station) => station.stationuuid && (station.url_resolved || station.url));
}

async function stationById(id) {
  const res = await request(`${RADIO_API}/stations/byuuid/${encodeURIComponent(id)}`, { timeoutMs: 5000, headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json())[0] ?? null;
}

function stationLabel(station) {
  const details = [station.countrycode, station.codec && `${station.codec}${station.bitrate ? ` ${station.bitrate}k` : ''}`].filter(Boolean).join(' · ');
  const name = station.name.trim().replace(/\s+/g, ' ');
  if (!details) return name.length > 100 ? `${name.slice(0, 99)}…` : name;
  const label = `${name} (${details})`;
  return label.length > 100 ? `${name.slice(0, 100 - details.length - 4)}… (${details})` : label;
}

// ---------------------------------------------------------------------------
// Sessions: one per server while Cardify is in a voice channel
// ---------------------------------------------------------------------------

const sessions = new Map();

function listenersIn(session) {
  const channel = session.guild.channels.cache.get(session.voiceChannelId);
  return channel?.members?.filter((member) => !member.user?.bot).size ?? 0;
}

async function startSession(interaction, voiceChannel) {
  const session = {
    guild: interaction.guild,
    guildId: interaction.guildId,
    voiceChannelId: voiceChannel.id,
    textChannelId: interaction.channelId,
    queue: [],
    current: null,
    volume: settingsFor(interaction.guildId).volume,
    loop: 'off',
    paused: false,
    autoPaused: false,
    nowPlaying: null,
    timers: {},
    ended: false,
  };
  session.connection = engine.join(voiceChannel);
  session.connection.on('error', (err) => console.error(`Music: voice connection error in "${session.guild.name}":`, err.message));
  session.connection.on('stateChange', (_, now) => {
    if (now.status === 'destroyed') endSession(session);
  });
  try {
    await engine.ready(session.connection);
  } catch (err) {
    session.ended = true;
    session.connection.destroy();
    throw err;
  }
  session.player = engine.createPlayer();
  session.player.on('error', (err) => console.error(`Music: couldn't play "${err.resource?.metadata?.title}":`, err.message));
  session.player.on('stateChange', (before, now) => {
    if (now.status === 'idle' && before.status !== 'idle') trackEnded(session, before.resource);
  });
  session.connection.subscribe(session.player);
  sessions.set(session.guildId, session);
  console.log(`Music: joined voice channel ${voiceChannel.id} in "${session.guild.name}".`);
  await postTutorial(session);
  return session;
}

// Every time the music joins: a quick how-to in the chat, before the first song.
async function postTutorial(session) {
  const channel = await textChannelOf(session);
  await channel?.send(tutorialPayload(session.guildId)).catch((err) => console.error('Music: the how-to card failed:', err.message));
}

function tutorialPayload(guildId) {
  const { voiceChatOnly, stay } = settingsFor(guildId);
  const lines = [
    "### 🎵 Hi! I'm here to play music",
    '🔎 **Play a song:** `/play song:` and type its name, or paste a YouTube or Spotify link',
    '📻 **Play the radio:** `/radio station:` and pick one, like lofi',
    '⏯️ **Pause, skip or stop:** press the buttons on the "Now playing" card',
    "📜 **See what's next:** `/music queue`  ·  🔊 **Volume:** `/music volume`",
    `-# ${voiceChatOnly ? "Music commands work right here in this channel's chat. " : ''}${stay ? 'I stay until someone uses `/music stop`.' : 'I leave when the music ends or everyone leaves.'}`,
  ];
  const container = new ContainerBuilder().setAccentColor(MUSIC_COLOR).addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
  return { flags: MessageFlags.IsComponentsV2, components: [container], allowedMentions: { parse: [] } };
}

function trackEnded(session, resource) {
  const finished = session.current;
  if (!finished || session.ended) return;
  finished.stop?.();
  const playedMs = resource?.playbackDuration ?? 0;
  if (!finished.skipped && playedMs < 1500) {
    // It ended right away: the link gave no audio.
    console.error(`Music: "${finished.title}" (${finished.url}) gave no audio: ${finished.errors?.trim().split('\n').pop() || 'no details'}`);
    const why = {
      youtube: "YouTube wouldn't play it (it may be private, age-restricted, or blocked here)",
      spotify: "I couldn't find it on YouTube Music",
    }[finished.kind] ?? 'that link gave no audio';
    announce(session, `⚠️ Couldn't play **${clean(finished.title)}** - ${why}. Skipping it.`);
  } else if (session.loop === 'track' && !finished.skipped) session.queue.unshift(finished);
  else if (session.loop === 'queue') session.queue.push(finished);
  session.current = null;
  playNext(session);
}

function playNext(session) {
  retireNowPlaying(session);
  const track = session.queue.shift();
  if (!track) {
    if (!settingsFor(session.guildId).stay) {
      session.timers.idle = setTimeout(() => endSession(session, `👋 Left <#${session.voiceChannelId}> - nothing left to play.`), IDLE_LEAVE_MS);
    }
    return;
  }
  clearTimeout(session.timers.idle);
  session.timers.idle = null;
  track.skipped = false;
  session.current = track;
  const { resource, stop } = engine.createResource(track, session.volume);
  track.stop = stop;
  session.resource = resource;
  session.paused = false;
  session.player.play(resource);
  postNowPlaying(session);
}

function endSession(session, message) {
  if (session.ended) return;
  session.ended = true;
  for (const timer of Object.values(session.timers)) clearTimeout(timer);
  session.current?.stop?.();
  session.queue = [];
  retireNowPlaying(session);
  session.player?.stop(true);
  if (session.connection.state.status !== 'destroyed') session.connection.destroy();
  if (sessions.get(session.guildId) === session) sessions.delete(session.guildId);
  console.log(`Music: left voice in "${session.guild.name}".`);
  if (message) announce(session, message);
}

// ---------------------------------------------------------------------------
// The "Now playing" card
// ---------------------------------------------------------------------------

const clean = (title) => {
  const text = String(title).replace(/[[\]]/g, '').trim();
  return escapeMarkdown(text.length > 100 ? `${text.slice(0, 99)}…` : text);
};

function trackLine(track) {
  return track.link ? `[${clean(track.title)}](${track.link})` : clean(track.title);
}

function nowPlayingPayload(session) {
  const track = session.current;
  const icon = track.kind === 'radio' ? '📻' : track.kind === 'clip' ? '🎬' : '🎶';
  const details = [
    track.live || track.kind === 'radio' ? '🔴 Live' : track.duration ? `⏱️ ${formatDuration(track.duration)}` : null,
    track.kind === 'spotify' ? '🟢 from Spotify' : null,
    `🔊 ${session.volume}%`,
    session.loop === 'track' ? '🔂 Repeating this song' : session.loop === 'queue' ? '🔁 Repeating the queue' : null,
    `added by <@${track.requesterId}>`,
  ].filter(Boolean);
  const next = session.queue[0];
  const lines = [
    `### ${icon} ${session.paused ? 'Paused' : 'Now playing'}`,
    `**${trackLine(track)}**`,
    `-# ${details.join('  ·  ')}`,
    next && `-# Up next: ${clean(next.title)}${session.queue.length > 1 ? ` and ${session.queue.length - 1} more` : ''}`,
  ].filter(Boolean);
  const container = new ContainerBuilder()
    .setAccentColor(MUSIC_COLOR)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('music:pause')
          .setStyle(ButtonStyle.Secondary)
          .setLabel(session.paused ? 'Resume' : 'Pause')
          .setEmoji(session.paused ? '▶️' : '⏸️'),
        new ButtonBuilder().setCustomId('music:skip').setStyle(ButtonStyle.Secondary).setLabel('Skip').setEmoji('⏭️'),
        new ButtonBuilder().setCustomId('music:stop').setStyle(ButtonStyle.Secondary).setLabel('Stop').setEmoji('⏹️'),
        new ButtonBuilder().setCustomId('music:queue').setStyle(ButtonStyle.Secondary).setLabel('Queue').setEmoji('📜')
      )
    );
  return { flags: MessageFlags.IsComponentsV2, components: [container], allowedMentions: { parse: [] } };
}

async function textChannelOf(session) {
  return client?.channels.fetch(session.textChannelId).catch(() => null);
}

async function postNowPlaying(session) {
  const track = session.current;
  const channel = await textChannelOf(session);
  const message = await channel?.send(nowPlayingPayload(session)).catch((err) => console.error('Music: now-playing card failed:', err.message));
  // A skip while it was being posted: it's already out of date.
  if (message && session.current !== track) retireMessage(message, track);
  else if (message) session.nowPlaying = { message, track };
}

// The previous song's card loses its buttons and becomes one line.
function retireNowPlaying(session) {
  if (!session.nowPlaying) return;
  retireMessage(session.nowPlaying.message, session.nowPlaying.track);
  session.nowPlaying = null;
}

function retireMessage(message, track) {
  const container = new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# 🎶 Played ${trackLine(track)} · added by <@${track.requesterId}>`));
  message.edit({ flags: MessageFlags.IsComponentsV2, components: [container], allowedMentions: { parse: [] } }).catch(() => {});
}

function refreshNowPlaying(session) {
  session.nowPlaying?.message.edit(nowPlayingPayload(session)).catch(() => {});
}

async function announce(session, content) {
  const channel = await textChannelOf(session);
  await channel?.send({ content, allowedMentions: { parse: [] } }).catch(() => {});
}

function queuePayload(session) {
  const lines = ['### 📜 Queue'];
  if (session.current) {
    const playedFor = session.resource?.playbackDuration ? ` · ${formatDuration(session.resource.playbackDuration / 1000)} in` : '';
    lines.push(`**Now:** ${trackLine(session.current)} - <@${session.current.requesterId}>${playedFor}${session.paused ? ' (paused)' : ''}`);
  }
  session.queue.slice(0, 15).forEach((track, i) => lines.push(`**${i + 1}.** ${trackLine(track)}${track.duration && !track.live ? ` \`${formatDuration(track.duration)}\`` : ''} - <@${track.requesterId}>`));
  if (session.queue.length === 0) lines.push('-# Nothing else queued - add songs with `/play` or `/radio`.');
  if (session.queue.length > 15) lines.push(`-# ...and ${session.queue.length - 15} more`);
  lines.push(`-# 🔊 ${session.volume}%${session.loop !== 'off' ? `  ·  ${session.loop === 'track' ? '🔂 repeating this song' : '🔁 repeating the queue'}` : ''}`);
  const container = new ContainerBuilder().setAccentColor(MUSIC_COLOR).addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
  return { flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [container], allowedMentions: { parse: [] } };
}

// 83 -> "1:23"
function formatDuration(seconds) {
  const total = Math.floor(seconds);
  const [h, m, s] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// ---------------------------------------------------------------------------
// Who may do what
// ---------------------------------------------------------------------------

// Admins can always; otherwise you have to be listening, and with a DJ role
// set you need it - unless it's your own song or nobody else is listening.
function controlProblem(interaction, session, { ownTrack = false } = {}) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return null;
  if (interaction.member?.voice?.channelId !== session.voiceChannelId) return `Join <#${session.voiceChannelId}> to control the music.`;
  const { djRoleId } = settingsFor(session.guildId);
  if (!djRoleId || ownTrack || interaction.member.roles?.cache.has(djRoleId) || listenersIn(session) <= 1) return null;
  return `Only members with <@&${djRoleId}> can do that while others are listening.`;
}

// With voice-chat-only on: where to go instead, or null when this is the place.
function chatProblem(interaction, voiceChannelId) {
  if (!settingsFor(interaction.guildId).voiceChatOnly || interaction.channelId === voiceChannelId) return null;
  return `🎵 Music commands work in <#${voiceChannelId}>'s own chat. Open the voice channel's chat (the **💬** button) and try again there.`;
}

// The allowed voice channels; a Join to Create channel counts for the ones it makes.
function voiceAllowed(guildId, channelId) {
  const { voiceChannels } = settingsFor(guildId);
  return !voiceChannels.length || voiceChannels.includes(channelId) || voiceChannels.includes(tempVoice.hubOf(guildId, channelId));
}

const privately = (interaction, content) =>
  interaction.deferred || interaction.replied
    ? interaction.followUp({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } })
    : interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

// ---------------------------------------------------------------------------
// /play and /radio
// ---------------------------------------------------------------------------

async function queueTracks(interaction, find) {
  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) return privately(interaction, 'Join a voice channel first, then I\'ll play there.');
  if (!voiceAllowed(interaction.guildId, voiceChannel.id)) {
    return privately(interaction, `I can only play music in ${settingsFor(interaction.guildId).voiceChannels.map((id) => `<#${id}>`).join(', ')}. Join one of those first.`);
  }
  let session = sessions.get(interaction.guildId);
  if (session && session.voiceChannelId !== voiceChannel.id && session.current) {
    return privately(interaction, `I'm already playing in <#${session.voiceChannelId}> - join that channel to add songs.`);
  }
  if (voiceChannel.type === ChannelType.GuildStageVoice) return privately(interaction, "I can't play in Stage channels - use a regular voice channel.");
  const wrongPlace = chatProblem(interaction, voiceChannel.id);
  if (wrongPlace) return privately(interaction, wrongPlace);
  const me = interaction.guild.members.me;
  if (!voiceChannel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]) || !voiceChannel.joinable) {
    return privately(interaction, `I can't join <#${voiceChannel.id}> - I need the Connect and Speak permissions there (or it's full).`);
  }
  const settings = settingsFor(interaction.guildId);
  const room = settings.maxQueue - (session?.queue.length ?? 0);
  if (room <= 0) return privately(interaction, `The queue is full (${settings.maxQueue} songs).`);

  await interaction.deferReply();
  const fail = async (text) => {
    await interaction.deleteReply().catch(() => {});
    await privately(interaction, text);
  };
  const found = await find();
  if (found.problem) return fail(found.problem);
  const tracks = found.tracks.slice(0, room);
  for (const track of tracks) track.requesterId = interaction.user.id;

  session = sessions.get(interaction.guildId);
  if (session && session.voiceChannelId !== voiceChannel.id) {
    if (session.current) return fail(`I'm already playing in <#${session.voiceChannelId}> - join that channel to add songs.`);
    // Nothing playing: follow the member to their channel.
    endSession(session);
    session = null;
  }
  if (!session) {
    try {
      session = await startSession(interaction, voiceChannel);
    } catch (err) {
      console.error(`Music: couldn't join voice channel ${voiceChannel.id}:`, err.message);
      return fail(`Couldn't connect to <#${voiceChannel.id}> - try again in a moment.`);
    }
  }
  session.textChannelId = interaction.channelId;
  session.queue.push(...tracks);
  const startsNow = !session.current;
  const one = tracks.length === 1 ? tracks[0] : null;
  const by = `<@${interaction.user.id}>`;
  const what = one ? `**${trackLine(one)}**` : `**${tracks.length} songs**${found.from ? ` from **${clean(found.from)}**` : ''}`;
  const cut = found.tracks.length > tracks.length ? ` (the queue only had room for ${tracks.length})` : '';
  const radioNote = !startsNow && (session.current.kind === 'radio' || session.current.live) ? ' The radio keeps playing until someone skips it.' : '';
  console.log(`Music: ${interaction.user.tag} (${interaction.user.id}) added ${one ? `"${one.title}" (${one.kind})` : `${tracks.length} songs from "${found.from}"`} in "${interaction.guild.name}".`);
  await interaction.editReply({
    content: startsNow
      ? `▶️ ${by} started ${what} in <#${voiceChannel.id}>.${cut}`
      : `➕ ${by} added ${what}${one ? ` - #${session.queue.length} in the queue` : ''}.${cut}${radioNote}`,
    allowedMentions: { parse: [] },
    flags: MessageFlags.SuppressEmbeds,
  });
  if (startsNow) playNext(session);
  else refreshNowPlaying(session);
}

async function play(interaction) {
  const song = interaction.options.getString('song')?.trim();
  const file = interaction.options.getAttachment('file');
  if (!song && !file) return privately(interaction, 'Tell me a `song` to search for (or paste a link), or pick a `file` to play.');
  return queueTracks(interaction, async () => {
    if (!file) return findTracks(song);
    const track = trackFromFile(file);
    return track.problem ? track : { tracks: [track] };
  });
}

async function radio(interaction) {
  const choice = interaction.options.getString('station', true).trim();
  return queueTracks(interaction, async () => {
    try {
      const station = choice.startsWith('uuid:') ? await stationById(choice.slice(5)) : (await searchStations(choice, 1))[0];
      if (!station) return { problem: `No radio station found for "${choice}".` };
      const url = station.url_resolved || station.url;
      if (!(await isPublicLink(url))) return { problem: "That station's stream isn't on the public internet." };
      // radio-browser asks apps to report plays (it ranks stations by them).
      request(`${RADIO_API}/url/${encodeURIComponent(station.stationuuid)}`, { headers: { 'User-Agent': USER_AGENT } })
        .then((res) => res.body?.cancel())
        .catch(() => {});
      return { tracks: [{ url, title: station.name.trim(), link: station.homepage || null, kind: 'radio', live: true }] };
    } catch (err) {
      console.error('Music: radio lookup failed:', err.message);
      return { problem: "Couldn't reach the radio directory - try again in a moment." };
    }
  });
}

async function handleAutocomplete(interaction) {
  if (interaction.commandName !== RADIO_COMMAND.name) return false;
  const query = interaction.options.getFocused().trim();
  const stations = query.length < 2 ? [] : await searchStations(query).catch(() => []);
  await interaction.respond(stations.slice(0, 25).map((station) => ({ name: stationLabel(station), value: `uuid:${station.stationuuid}` }))).catch(() => {});
  return true;
}

// ---------------------------------------------------------------------------
// /music and the card's buttons
// ---------------------------------------------------------------------------

// Each action returns what to tell the member, or an object with `problem`.
const ACTIONS = {
  queue: (session) => ({ payload: queuePayload(session) }),
  skip(session, interaction) {
    if (!session.current) return { problem: 'Nothing is playing.' };
    const problem = controlProblem(interaction, session, { ownTrack: session.current.requesterId === interaction.user.id });
    if (problem) return { problem };
    const skipped = session.current;
    skipped.skipped = true;
    session.player.stop(true);
    return { done: `⏭️ <@${interaction.user.id}> skipped **${trackLine(skipped)}**.` };
  },
  pause(session, interaction) {
    if (!session.current) return { problem: 'Nothing is playing.' };
    const problem = controlProblem(interaction, session);
    if (problem) return { problem };
    if (session.paused) return { problem: 'The music is already paused - use `/music resume`.' };
    session.player.pause();
    session.paused = true;
    session.autoPaused = false;
    refreshNowPlaying(session);
    return { done: `⏸️ <@${interaction.user.id}> paused the music.` };
  },
  resume(session, interaction) {
    if (!session.current) return { problem: 'Nothing is playing.' };
    const problem = controlProblem(interaction, session);
    if (problem) return { problem };
    if (!session.paused) return { problem: "The music isn't paused." };
    session.player.unpause();
    session.paused = false;
    refreshNowPlaying(session);
    return { done: `▶️ <@${interaction.user.id}> resumed the music.` };
  },
  stop(session, interaction) {
    const problem = controlProblem(interaction, session);
    if (problem) return { problem };
    endSession(session);
    return { done: `⏹️ <@${interaction.user.id}> stopped the music.` };
  },
  volume(session, interaction) {
    const problem = controlProblem(interaction, session);
    if (problem) return { problem };
    session.volume = interaction.options.getInteger('percent', true);
    session.resource?.volume?.setVolume(session.volume / 100);
    refreshNowPlaying(session);
    return { done: `🔊 <@${interaction.user.id}> set the volume to ${session.volume}%.` };
  },
  remove(session, interaction) {
    const position = interaction.options.getInteger('position', true);
    const track = session.queue[position - 1];
    if (!track) return { problem: `There's no song #${position} - see \`/music queue\`.` };
    const problem = controlProblem(interaction, session, { ownTrack: track.requesterId === interaction.user.id });
    if (problem) return { problem };
    session.queue.splice(position - 1, 1);
    refreshNowPlaying(session);
    return { done: `🗑️ <@${interaction.user.id}> removed **${trackLine(track)}** from the queue.` };
  },
  shuffle(session, interaction) {
    const problem = controlProblem(interaction, session);
    if (problem) return { problem };
    if (session.queue.length < 2) return { problem: 'There are not enough songs in the queue to shuffle.' };
    for (let i = session.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [session.queue[i], session.queue[j]] = [session.queue[j], session.queue[i]];
    }
    refreshNowPlaying(session);
    return { done: `🔀 <@${interaction.user.id}> shuffled the queue.` };
  },
  loop(session, interaction) {
    const problem = controlProblem(interaction, session);
    if (problem) return { problem };
    session.loop = interaction.options.getString('mode', true);
    refreshNowPlaying(session);
    const what = { off: 'turned repeat off', track: 'set this song to repeat', queue: 'set the queue to repeat' }[session.loop];
    return { done: `${session.loop === 'off' ? '➡️' : session.loop === 'track' ? '🔂' : '🔁'} <@${interaction.user.id}> ${what}.` };
  },
};

async function musicCommand(interaction) {
  const session = sessions.get(interaction.guildId);
  if (!session) return privately(interaction, "I'm not playing anything - start with `/play` or `/radio`.");
  // Admins can still step in from anywhere.
  const wrongPlace = !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) && chatProblem(interaction, session.voiceChannelId);
  if (wrongPlace) return privately(interaction, wrongPlace);
  const result = ACTIONS[interaction.options.getSubcommand()](session, interaction);
  if (result.problem) return privately(interaction, result.problem);
  if (result.payload) return interaction.reply(result.payload);
  return interaction.reply({ content: result.done, allowedMentions: { parse: [] } });
}

async function handleButton(interaction, action) {
  const session = sessions.get(interaction.guildId);
  if (!session || session.nowPlaying?.message.id !== interaction.message.id) {
    return privately(interaction, 'This player has finished - start a new one with `/play` or `/radio`.');
  }
  if (action === 'pause') action = session.paused ? 'resume' : 'pause';
  const result = ACTIONS[action]?.(session, interaction);
  if (!result) return;
  if (result.problem) return privately(interaction, result.problem);
  if (result.payload) return interaction.reply(result.payload);
  // The card itself shows the change; the rest is said out loud.
  if (action === 'pause' || action === 'resume') return interaction.update(nowPlayingPayload(session));
  return interaction.reply({ content: result.done, allowedMentions: { parse: [] } });
}

// ---------------------------------------------------------------------------
// /music-setup
// ---------------------------------------------------------------------------

async function setup(interaction) {
  const reply = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return reply('Only people with the **Manage Server** permission can use /music-setup.');
  const settings = settingsFor(interaction.guildId);
  const sub = interaction.options.getSubcommand();
  const by = `${interaction.user.tag} (${interaction.user.id})`;
  let text;
  if (sub === 'dj-role') {
    settings.djRoleId = interaction.options.getRole('role')?.id ?? null;
    text = settings.djRoleId
      ? `Only <@&${settings.djRoleId}> (and admins) can skip others' songs, stop, pause, or change the volume while others are listening. Everyone can still add songs.`
      : 'Everyone listening can control the music.';
  } else if (sub === 'voice-channel') {
    const channelId = interaction.options.getChannel('channel', true).id;
    const allowed = interaction.options.getBoolean('allowed', true);
    settings.voiceChannels = allowed ? [...new Set([...settings.voiceChannels, channelId])] : settings.voiceChannels.filter((id) => id !== channelId);
    text = settings.voiceChannels.length
      ? `I can play music in: ${settings.voiceChannels.map((id) => `<#${id}>`).join(', ')}.`
      : 'I can play music in any voice channel.';
  } else if (sub === 'voice-chat-only') {
    settings.voiceChatOnly = interaction.options.getBoolean('on', true);
    text = settings.voiceChatOnly
      ? 'Music commands now only work in the chat of the voice channel the music is in (the **💬** button on a voice channel), and the "Now playing" card shows up there.'
      : 'Music commands work in any text channel, and the "Now playing" card goes where someone uses `/play`.';
  } else if (sub === 'volume') {
    settings.volume = interaction.options.getInteger('percent', true);
    text = `The music starts at ${settings.volume}% volume.`;
  } else if (sub === 'queue-limit') {
    settings.maxQueue = interaction.options.getInteger('songs', true);
    text = `The queue holds up to ${settings.maxQueue} songs.`;
  } else if (sub === 'stay') {
    settings.stay = interaction.options.getBoolean('on', true);
    text = settings.stay ? 'I stay in the voice channel until someone uses `/music stop` (24/7).' : 'I leave the voice channel when the music ends or everyone leaves.';
    const session = sessions.get(interaction.guildId);
    if (session && settings.stay) {
      for (const timer of Object.values(session.timers)) clearTimeout(timer);
      session.timers = {};
    }
  } else {
    const session = sessions.get(interaction.guildId);
    return reply(
      [
        `**DJ role:** ${settings.djRoleId ? `<@&${settings.djRoleId}>` : 'none - everyone listening can control the music'}`,
        `**Voice channels:** ${settings.voiceChannels.length ? settings.voiceChannels.map((id) => `<#${id}>`).join(', ') : 'any'}`,
        `**Commands work in:** ${settings.voiceChatOnly ? "the music's voice channel chat only" : 'any text channel'}`,
        '-# Who can use the music commands: `/access`',
        `**Starting volume:** ${settings.volume}%`,
        `**Queue limit:** ${settings.maxQueue} songs`,
        `**24/7:** ${settings.stay ? 'on' : 'off - I leave when the music ends or everyone leaves'}`,
        `**Right now:** ${session ? `in <#${session.voiceChannelId}>, ${session.current ? `playing ${trackLine(session.current)}` : 'nothing playing'}` : 'not in a voice channel'}`,
      ].join('\n')
    );
  }
  store.save();
  console.log(`/music-setup: ${by} changed ${sub}.`);
  return reply(text);
}

async function handleCommand(interaction) {
  const name = interaction.commandName;
  if (name === PLAY_COMMAND.name) await play(interaction);
  else if (name === RADIO_COMMAND.name) await radio(interaction);
  else if (name === MUSIC_COMMAND.name) await musicCommand(interaction);
  else if (name === SETUP_COMMAND.name) await setup(interaction);
  else return false;
  return true;
}

// ---------------------------------------------------------------------------
// Voice channel changes (index.js forwards these)
// ---------------------------------------------------------------------------

function voiceStateChanged(before, after) {
  const session = sessions.get(after.guild.id);
  if (!session || session.ended) return;
  if (after.id === client?.user?.id) {
    // Moved by someone: follow along, chat too. (Disconnects end the session through the connection.)
    if (after.channelId) {
      session.voiceChannelId = after.channelId;
      if (settingsFor(session.guildId).voiceChatOnly) session.textChannelId = after.channelId;
    }
  } else if (before.channelId !== session.voiceChannelId && after.channelId !== session.voiceChannelId) return;
  if (settingsFor(session.guildId).stay) return;
  const listeners = listenersIn(session);
  if (listeners === 0 && !session.timers.alone) {
    if (session.current && !session.paused) {
      session.player.pause();
      session.paused = true;
      session.autoPaused = true;
      refreshNowPlaying(session);
    }
    session.timers.alone = setTimeout(() => endSession(session, `👋 Left <#${session.voiceChannelId}> - everyone left.`), ALONE_LEAVE_MS);
  } else if (listeners > 0 && session.timers.alone) {
    clearTimeout(session.timers.alone);
    session.timers.alone = null;
    if (session.autoPaused) {
      session.player.unpause();
      session.paused = false;
      session.autoPaused = false;
      refreshNowPlaying(session);
    }
  }
}

// For /setup.
function setMusicSettings(guildId, changes) {
  Object.assign(settingsFor(guildId), changes);
  store.save();
}

module.exports = {
  commands: [PLAY_COMMAND, RADIO_COMMAND, MUSIC_COMMAND, SETUP_COMMAND],
  handleCommand,
  handleAutocomplete,
  handleButton,
  voiceStateChanged,
  init,
  musicSettings: (guildId) => settingsFor(guildId),
  setMusicSettings,
  // For tests and previews.
  tutorialPayload,
  engine,
  sessions,
  isPublicLink,
  firstPlaylistEntry,
  asLink,
  findTracks,
};
