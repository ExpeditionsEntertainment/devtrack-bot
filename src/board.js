// board.js
// The Discord side of the Assets board (DevTrack's /assets/ page).
//
//   reading     every message in the channels the board reads goes to the backend
//               (/api/bot/board/messages), which goes through them every few hours and
//               lists the updates on the page. The board says which channels: each dev's
//               place on the Developers tab and the channels picked in its settings. A
//               forum counts for every post in it, a category for every channel in it.
//   check-ins   once a day the backend sends the owner a DM (via the webhook, /board-digest)
//               listing the in-progress tasks nobody has heard about lately.
//   ping        "Ask how it's going" on the page (/board-ping): a message in the dev's place
//               on Discord (their channel on the Developers tab), mentioning them. Never a DM.
//               A forum or category has no messages of its own, so it goes in the open post
//               about that card if there is one, else the newest post or channel there.

const axios = require('axios');
const { EmbedBuilder, ChannelType } = require('discord.js');

const API_URL = process.env.API_URL || 'http://localhost:3001';
const OWNER = String(process.env.PERSONAL_OWNER_DISCORD_ID || process.env.CONVERT_OWNER_ID || '618957089833877518').trim();
const WATCH_MS = 5 * 60 * 1000;
const bot = () => ({ headers: { 'x-bot-secret': process.env.BOT_SECRET }, timeout: 15000 });

let client = null;
let watched = new Set();

async function loadWatch() {
  try {
    const { data } = await axios.get(`${API_URL}/api/bot/board/watch`, bot());
    const next = new Set(data.channelIds || []);
    if ([...next].sort().join() !== [...watched].sort().join()) console.log(`[Board] Reading ${next.size} channel(s) for the Assets board`);
    watched = next;
  } catch (err) {
    console.error('[Board] Could not load the channels to read:', err.response?.data?.error || err.message);
  }
}

function start(discordClient) {
  client = discordClient;
  loadWatch();
  setInterval(loadWatch, WATCH_MS);
}

// The message's channel, the thread's forum or channel, or the category above either.
function isWatched(message) {
  if (!watched.size || !message.guildId) return false;
  const ch = message.channel;
  return [message.channelId, ch?.parentId, ch?.parent?.parentId].some(id => id && watched.has(id));
}

// Called for every message from a person; sends it on if it's in a channel the board reads.
function onMessage(message) {
  if (!isWatched(message)) return;
  const ch = message.channel;
  const thread = ch?.isThread?.() ? ch : null;
  const payload = {
    id: message.id,
    channelId: thread ? thread.parentId : message.channelId,
    threadId: thread ? thread.id : null,
    place: thread ? `${thread.parent?.name || 'forum'} › ${thread.name}` : ch?.name || '',
    authorId: message.author.id,
    authorName: message.member?.displayName || message.author.globalName || message.author.username,
    content: message.content || '',
    url: message.url,
    postedAt: new Date(message.createdTimestamp).toISOString(),
    attachments: [...message.attachments.values()].map(a => ({ name: a.name, url: a.url, contentType: a.contentType, size: a.size, width: a.width, height: a.height })),
  };
  if (!payload.content && !payload.attachments.length) return;
  axios.post(`${API_URL}/api/bot/board/messages`, payload, { ...bot(), timeout: 60000 })
    .catch(err => console.error('[Board] Could not send a message to the board:', err.response?.data?.error || err.message));
}

class Refused extends Error { constructor(message) { super(message); this.status = 400; } }

// The owner's daily DM: { date, stale: [{ unit, task, dev, days, url }], updates, url, updatesUrl }
async function digest(p) {
  if (!client?.isReady()) throw new Error('The bot is not connected to Discord yet');
  const owner = await client.users.fetch(OWNER).catch(() => null);
  if (!owner) throw new Refused(`Can't find the owner account ${OWNER}`);
  const lines = (p.stale || []).slice(0, 15).map(s => `• [**${s.unit} › ${s.task}**](${s.url}): ${s.dev || 'nobody named'}, ${s.days} day${s.days === 1 ? '' : 's'} with no news`);
  if ((p.stale || []).length > 15) lines.push(`…and ${p.stale.length - 15} more`);
  const embed = new EmbedBuilder()
    .setColor(0xff9f0a)
    .setTitle((p.stale || []).length ? `🔎 ${p.stale.length} task${p.stale.length === 1 ? '' : 's'} to check in on` : '📬 Updates waiting')
    .setDescription([...lines, '', `[Open the Assets board](${p.url})${p.updates ? ` · **${p.updates}** update${p.updates === 1 ? '' : 's'} from Discord to go through: [see them](${p.updatesUrl})` : ''}`].join('\n').slice(0, 4000))
    .setFooter({ text: `DevTrack · ${p.date}` });
  await owner.send({ embeds: [embed] }).catch(err => { throw new Refused(`Could not DM the owner: ${err.message}`); });
}

// ── asking a dev how it's going, in their place ──

const FORUMS = [ChannelType.GuildForum, ChannelType.GuildMedia];
const CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const words = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const latest = c => BigInt(c.lastMessageId || c.id); // the most recent message (or when it was made)

async function openPosts(forum) {
  const active = await forum.threads.fetchActive().catch(() => null);
  return [...(active?.threads.values() || [])].filter(t => t.parentId === forum.id && !t.archived);
}

// How well a post's or channel's name fits: the card's name (or its first word: "Dio" for "Dio
// OverHeaven") counts most, then the task's.
function fit(name, card, task) {
  const n = ` ${words(name)} `;
  const c = words(card), c1 = c.split(' ')[0], t = words(task).split(' ')[0];
  const cardHit = c && (n.includes(` ${c} `) || (c1.length >= 3 && n.includes(` ${c1} `)));
  return (cardHit ? 2 : 0) + (t && n.includes(` ${t}`) ? 1 : 0);
}
const best = (list, card, task) => list.map(c => ({ c, f: fit(c.name, card, task), r: latest(c) }))
  .sort((a, b) => b.f - a.f || (b.r > a.r ? 1 : b.r < a.r ? -1 : 0))[0]?.c || null;

// Where to ask: their place itself when it takes messages (a channel or a post). A forum: its open post
// about this card, else the one most recently posted in. A category: a post or channel about this card,
// else its most recently used channel, else its newest open post.
async function placeToAsk(channelId, card, task) {
  const place = await client.channels.fetch(channelId).catch(() => null);
  if (!place) return null;
  if (place.isThread?.() || CHANNELS.includes(place.type)) return place;
  if (FORUMS.includes(place.type)) return best(await openPosts(place), card, task);
  if (place.type === ChannelType.GuildCategory) {
    const kids = [...place.children.cache.values()];
    const posts = (await Promise.all(kids.filter(k => FORUMS.includes(k.type)).map(openPosts))).flat();
    const chans = kids.filter(k => CHANNELS.includes(k.type));
    const all = best([...posts, ...chans], card, task);
    if (all && fit(all.name, card, task)) return all;
    return best(chans, card, task) || best(posts, card, task);
  }
  return null;
}

// Ask a dev how a task is going: { userId, channelId, text, from, card, task }. In their place on
// Discord, mentioning them; never a DM.
async function ping(p) {
  if (!client?.isReady()) throw new Error('The bot is not connected to Discord yet');
  if (!p.channelId) throw new Refused('They have no place on the Developers tab to ask in');
  const place = await placeToAsk(p.channelId, p.card, p.task);
  if (!place) throw new Refused('The bot can\'t find their channel, or an open post in it, to ask in');
  const content = `${p.userId ? `<@${p.userId}> ` : ''}${p.text}\n-# Asked by ${p.from || 'the team'} via DevTrack`.slice(0, 2000);
  await place.send({ content, allowedMentions: { users: p.userId ? [p.userId] : [] } })
    .catch(err => { throw new Refused(`Could not post in #${place.name}: ${err.message}`); });
  return { place: place.name, id: place.id };
}

module.exports = { start, onMessage, digest, ping, isWatched };
