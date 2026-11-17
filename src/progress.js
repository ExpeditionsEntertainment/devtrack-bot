// progress.js
// The progress channel: the Assets board on Discord, as cards that keep themselves up to date.
//
//   each game update   a header (a progress bar, how many tasks are where), then a message per
//                      card: its progress bar, every task in the template's order (Animations,
//                      Mesh, Texture...) with its status and who's on it, why a blocked one is
//                      blocked, and the card's image
//
// The bot keeps its own messages in the channel in that order and edits them in place: a change
// edits only the message it touches, and a new card moves the ones after it down by editing them,
// so nothing is reposted and nobody is pinged. It only touches its own cards (a footer saying
// DevTrack Assets); other messages are left alone, but the channel reads best if only the bot
// can post in it.
//
// Redrawn a few seconds after the board changes (the backend calls /board-progress, and
// /dots-refresh when a dev changes) and every 10 minutes in case a call was missed.
// Needs BOARD_PROGRESS_CHANNEL_ID, and View Channel, Send Messages, Embed Links and Read Message
// History in that channel.

const axios = require('axios');
const { EmbedBuilder, PermissionFlagsBits, MessageType } = require('discord.js');

const API_URL = process.env.API_URL || 'http://localhost:3001';
const CHANNEL_ID = String(process.env.BOARD_PROGRESS_CHANNEL_ID || '').trim();
const DASHBOARD = (process.env.DASHBOARD_URL || 'https://aedevtrack.netlify.app').replace(/\/+$/, '');
const SYNC_MS = 10 * 60 * 1000;
const MARK = 'DevTrack Assets'; // in every footer: how the bot knows its own cards
const bot = () => ({ headers: { 'x-bot-secret': process.env.BOT_SECRET }, timeout: 20000 });

// The Assets page's colours.
const COLOR = { done: 0x30d158, in_progress: 0xff9f0a, blocked: 0xff375f, untasked: 0x8e8e93, update: 0x5e5ce6 };
const DOT = { done: '✅', in_progress: '🟠', blocked: '⛔', untasked: '⚪' };
const CELL = { done: '🟩', in_progress: '🟧', blocked: '🟥', untasked: '⬛' };
const ORDER = ['done', 'in_progress', 'blocked', 'untasked'];
const WORD = { done: 'done', in_progress: 'in progress', blocked: 'blocked', untasked: 'to do' };

const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const md = s => String(s ?? '').replace(/([\\*_~`|])/g, '\\$1');
const ts = iso => (iso && Number.isFinite(Date.parse(iso)) ? `<t:${Math.floor(Date.parse(iso) / 1000)}:R>` : '');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const totalOf = k => ORDER.reduce((s, st) => s + (k[st] || 0), 0);
const pct = k => { const t = totalOf(k); return t ? Math.floor(((k.done || 0) / t) * 100) : 0; };
const complete = k => totalOf(k) > 0 && k.done === totalOf(k);

// A bar of coloured squares: done, in progress, blocked, to do. Every status there is gets at least
// one square, so a single blocked task still shows; it's only all green when everything is done.
function bar(k, width) {
  const total = totalOf(k);
  if (!total) return CELL.untasked.repeat(width);
  const exact = ORDER.map(st => ((k[st] || 0) / total) * width);
  const cells = exact.map(Math.floor);
  ORDER.forEach((st, i) => { if (k[st] && !cells[i]) cells[i] = 1; });
  let left = width - cells.reduce((a, b) => a + b, 0);
  const byRest = ORDER.map((st, i) => i).filter(i => k[ORDER[i]]).sort((a, b) => (exact[b] - cells[b]) - (exact[a] - cells[a]));
  for (let j = 0; left > 0; j++) { cells[byRest[j % byRest.length]]++; left--; }
  while (left < 0) { const i = cells.indexOf(Math.max(...cells)); cells[i]--; left++; }
  return ORDER.map((st, i) => CELL[st].repeat(cells[i])).join('');
}

// "✅ 4 done · 🟠 2 in progress · ⚪ 6 to do": only the ones there are.
const tally = (k, skip = []) => ORDER.filter(st => k[st] && !skip.includes(st)).map(st => `${DOT[st]} ${k[st]} ${WORD[st]}`).join('  ·  ');

// As many lines (or blocks of lines) as fit, then how many more there were.
function fit(parts, max, join = '\n') {
  const out = [];
  let len = 0;
  for (let i = 0; i < parts.length; i++) {
    const more = `*…and ${parts.length - i} more*`;
    const add = (out.length ? join.length : 0) + parts[i].length;
    const roomForMore = i < parts.length - 1 ? join.length + more.length : 0;
    if (len + add + roomForMore > max) { out.push(more); break; }
    out.push(parts[i]);
    len += add;
  }
  return out.join(join);
}

// A task on a card: its status, who's on it, since when, and why it's blocked.
function taskLine(t, sub) {
  const lead = sub ? ' └ ' : '';
  const name = sub ? md(t.name) : `**${md(t.name)}**`;
  const who = t.dev?.name ? ` · ${md(t.dev.name)}` : '';
  const when = t.status === 'in_progress' && t.startedAt ? ` · started ${ts(t.startedAt)}`
    : t.status === 'blocked' && t.blocked?.since ? ` · since ${ts(t.blocked.since)}` : '';
  const line = `${lead}${DOT[t.status] || DOT.untasked} ${name}${who}${when}`;
  if (t.status !== 'blocked') return line;
  return `${line}\n${sub ? '  ' : ' '}↳ *${md(clip(t.blocked?.reason || 'No reason given', 160))}*`;
}

function cardEmbed(c, updateName) {
  const k = c.counts || {};
  const tag = [c.rarity && String(c.rarity).toUpperCase(), c.kind && c.kind !== 'unit' && c.kind[0].toUpperCase() + c.kind.slice(1), c.element]
    .filter(Boolean).join(' · ');
  const head = !totalOf(k) ? '*No tasks yet*'
    : `${bar(k, 10)}  **${pct(k)}%**\n${complete(k) ? `✅ **Complete** · ${plural(k.done, 'task')}` : tally(k)}`;
  const lines = (c.tasks || []).flatMap(t => [taskLine(t, false), ...(t.subtasks || []).map(s => taskLine(s, true))]);
  const e = new EmbedBuilder()
    .setColor(k.blocked ? COLOR.blocked : complete(k) ? COLOR.done : k.in_progress || k.done ? COLOR.in_progress : COLOR.untasked)
    .setTitle(clip(c.name, 250))
    .setURL(`${DASHBOARD}/assets/?card=${encodeURIComponent(c.identifier)}`)
    .setDescription(`${head}\n\n${fit(lines, 4000 - head.length)}`)
    .setFooter({ text: `${c.identifier} · ${MARK}` });
  const author = [tag, updateName].filter(Boolean).join('  ·  ');
  if (author) e.setAuthor({ name: clip(author, 250) });
  if (c.image) e.setThumbnail(c.image);
  if (c.changedAt) e.setTimestamp(new Date(c.changedAt));
  return e;
}

// A game update's header: everything on its cards added up.
function updateEmbed(u) {
  const k = {};
  for (const c of u.cards) for (const st of ORDER) k[st] = (k[st] || 0) + (c.counts?.[st] || 0);
  const done = u.cards.filter(c => complete(c.counts || {})).length;
  const lines = [
    `${bar(k, 12)}  **${pct(k)}%**`,
    `**${k.done || 0}** of **${totalOf(k)}** tasks done across ${plural(u.cards.length, 'card')}${done ? ` · **${done}** complete` : ''}`,
    tally(k, ['done']),
  ].filter(Boolean);
  const changed = u.cards.map(c => c.changedAt).filter(Boolean).sort().at(-1);
  const e = new EmbedBuilder()
    .setColor(COLOR.update)
    .setTitle(clip(u.name ? `🎮  ${u.name}` : '📦  Not in an update', 250))
    .setURL(`${DASHBOARD}/assets/`)
    .setDescription(lines.join('\n'))
    .setFooter({ text: MARK });
  if (changed) e.setTimestamp(new Date(changed));
  return e;
}

// Every message the channel should show, top to bottom, each a list of embeds.
function draw(p) {
  const msgs = [];
  for (const u of p.updates || []) {
    msgs.push([updateEmbed(u)]);
    for (const c of u.cards) msgs.push([cardEmbed(c, u.name)]);
  }
  return msgs.map(list => list.map(e => e.toJSON()));
}

// What a message shows, to tell whether it needs an edit (Discord hands embeds back reworded a little).
const sig = embeds => JSON.stringify((embeds || []).map(e => {
  const d = e.data || e;
  return [String(d.title || '').trim(), String(d.description || '').trim(), d.url || '', d.color ?? 0, String(d.author?.name || '').trim(),
    String(d.footer?.text || '').trim(), d.timestamp ? Date.parse(d.timestamp) : 0, d.thumbnail?.url || '',
    (d.fields || []).map(f => [f.name, f.value, !!f.inline])];
}));

let client = null;
let running = false;
let again = false;
let timer = null;
let problem = '';

function complain(text) {
  if (text !== problem) console.error(`[Progress] ${text}`);
  problem = text;
}

const ours = m => m.author?.id === client.user.id && m.type === MessageType.Default && !m.content && !m.interactionMetadata
  && m.embeds.length > 0 && m.embeds.some(e => String(e.footer?.text || '').includes(MARK));

// The bot's cards in the channel, oldest (top) first.
async function ownMessages(channel) {
  const out = [];
  let before;
  for (let page = 0; page < 10; page++) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    for (const m of batch.values()) if (ours(m)) out.push(m);
    if (batch.size < 100) break;
    before = batch.last().id;
  }
  return out.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

async function syncOnce() {
  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased?.() || channel.isDMBased?.() || !channel.messages) {
    return complain(`Can't find the progress channel ${CHANNEL_ID}, or it isn't a text channel`);
  }
  const perms = channel.permissionsFor?.(client.user);
  const need = { ViewChannel: 'View Channel', SendMessages: 'Send Messages', EmbedLinks: 'Embed Links', ReadMessageHistory: 'Read Message History' };
  const missing = Object.keys(need).filter(k => !perms?.has(PermissionFlagsBits[k])).map(k => need[k]);
  if (missing.length) return complain(`The bot needs ${missing.join(', ')} in #${channel.name} for the progress cards`);

  const { data } = await axios.get(`${API_URL}/api/bot/board/progress`, bot());
  const want = draw(data);
  const have = await ownMessages(channel);
  let posted = 0, edited = 0, removed = 0;
  for (let i = 0; i < want.length; i++) {
    if (i >= have.length) {
      await channel.send({ embeds: want[i], allowedMentions: { parse: [] } });
      posted++;
    } else if (sig(have[i].embeds) !== sig(want[i])) {
      await have[i].edit({ embeds: want[i], allowedMentions: { parse: [] } });
      edited++;
    }
  }
  for (const m of have.slice(want.length)) {
    await m.delete().catch(err => console.error(`[Progress] Could not delete an old card: ${err.message}`));
    removed++;
  }
  if (posted || edited || removed) console.log(`[Progress] #${channel.name}: ${posted} posted, ${edited} edited, ${removed} removed`);
  problem = '';
}

async function sync() {
  if (running) { again = true; return; }
  running = true;
  try {
    await syncOnce();
  } catch (err) {
    complain(`Could not update the progress cards: ${err.response?.data?.error || err.message}`);
  } finally {
    running = false;
    if (again) { again = false; refreshSoon(1000); }
  }
}

// Redraw in a few seconds: a burst of changes is one redraw.
function refreshSoon(ms = 3000) {
  if (!CHANNEL_ID || !client?.isReady?.() || timer) return;
  timer = setTimeout(() => { timer = null; sync(); }, ms);
}

function start(discordClient) {
  client = discordClient;
  if (!CHANNEL_ID) { console.log('[Progress] Off: set BOARD_PROGRESS_CHANNEL_ID to show the Assets board in a channel'); return; }
  console.log(`[Progress] Showing the Assets board as cards in channel ${CHANNEL_ID}`);
  refreshSoon(10000);
  setInterval(() => refreshSoon(0), SYNC_MS);
}

module.exports = {
  start, refreshSoon, draw, bar, sig,
  _syncOnce: c => { client = c; return syncOnce(); }, // for trying it against a stand-in channel
};
