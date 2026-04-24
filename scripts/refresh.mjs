#!/usr/bin/env node
// Ringside data aggregator — runs hourly in GitHub Actions, writes
// leaderboard.json consumed by the extension. Zero user config required:
// the extension just fetches the raw file from GitHub.
//
// Each source is independent; failures are logged and skipped.

import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';

const ORG_COLOR = {
  'OpenAI': '#10a37f', 'Anthropic': '#c96442', 'Google': '#4285f4',
  'xAI': '#1a1a1a', 'DeepSeek': '#4d6bfe', 'Meta': '#0866ff',
  'Mistral AI': '#ff7000', 'Mistral': '#ff7000', 'Alibaba': '#ff6a00',
  'Cohere': '#39594d', '01.AI': '#0ea5e9', 'Microsoft': '#00a4ef',
  'Amazon': '#ff9900', 'Midjourney': '#0d1117', 'Black Forest Labs': '#111',
  'Ideogram': '#ff6b35', 'Stability AI': '#ff3366', 'Recraft': '#6c5ce7',
  'Adobe': '#fa0f00', 'Kuaishou': '#ff6900', 'Runway': '#00ff88',
  'Pika': '#ff4d6d', 'MiniMax': '#0066ff', 'Luma': '#7c3aed',
  'Qwen': '#ff6a00', 'Moonshot': '#8b5cf6', 'Nvidia': '#76b900',
};

const sources = {};
const errors = [];

async function tryFetch(name, fn) {
  try {
    const v = await fn();
    sources[name] = `ok (${Array.isArray(v) ? v.length : typeof v})`;
    return v;
  } catch (e) {
    sources[name] = `err: ${e.message}`;
    errors.push(`${name}: ${e.message}`);
    return null;
  }
}

// ─── OpenRouter: model catalog (no key, public) ────────────────────────────
async function fetchOpenRouter() {
  const r = await fetch('https://openrouter.ai/api/v1/models', { headers: { 'accept': 'application/json' } });
  if (!r.ok) throw new Error('http ' + r.status);
  const body = await r.json();
  return body.data || [];
}

// ─── Aider polyglot leaderboard: code benchmark, YAML in GitHub ────────────
async function fetchAider() {
  const urls = [
    'https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/_data/polyglot_leaderboard.yml',
    'https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/_data/edit_leaderboard.yml',
  ];
  for (const u of urls) {
    const r = await fetch(u);
    if (!r.ok) continue;
    const text = await r.text();
    const parsed = yaml.load(text);
    if (Array.isArray(parsed) && parsed.length) return parsed;
  }
  throw new Error('no aider yaml found');
}

// ─── arena.ai (new LMArena): scrape SSR'd leaderboard from Next.js chunks ──
// Each category page embeds full leaderboard data in __next_f chunks as an
// array of { rank, modelDisplayName, rating, votes, modelOrganization, ... }.
// Updated by LMArena continuously — same source their own site shows.
async function fetchArena(slug) {
  const html = await (await fetch(`https://arena.ai/leaderboard/${slug}`, {
    headers: { 'user-agent': 'Mozilla/5.0 Ringside/1.0' },
  })).text();
  if (!html || html.length < 10000) throw new Error('html too small: ' + html.length);

  // Concatenate all self.__next_f.push chunks; strings inside are JSON-escaped.
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,"(.*?)"\]\)/gs)].map(m => m[1]);
  const big = chunks.join('');

  // Find { "entries": [...] } array and parse each entry object. The entries
  // are JSON-escaped (\" instead of "), so unescape per-entry before JSON.parse.
  const entries = [];
  // Match object bodies inside entries array — each starts with {\"rank\":
  const re = /\{\\"rank\\":\d+[^{}]*?\\"rating\\":[\d.]+[^{}]*?\}/g;
  let m;
  while ((m = re.exec(big))) {
    try {
      const unescaped = m[0].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      const obj = JSON.parse(unescaped);
      entries.push(obj);
    } catch { /* skip malformed */ }
  }
  if (!entries.length) throw new Error('no entries parsed');
  return entries;
}

async function fetchArenaAll() {
  // Map arena.ai category slugs to our internal categories.
  const [text, code, image, video] = await Promise.all([
    fetchArena('text').catch(e => (sources.arena_text = 'err: ' + e.message, null)),
    fetchArena('code').catch(e => (sources.arena_code = 'err: ' + e.message, null)),
    fetchArena('text-to-image').catch(e => (sources.arena_image = 'err: ' + e.message, null)),
    fetchArena('text-to-video').catch(e => (sources.arena_video = 'err: ' + e.message, null)),
  ]);
  if (text)  sources.arena_text  = `ok (${text.length})`;
  if (code)  sources.arena_code  = `ok (${code.length})`;
  if (image) sources.arena_image = `ok (${image.length})`;
  if (video) sources.arena_video = `ok (${video.length})`;
  return { text, code, image, video };
}

// ─── LiveBench: CSV in GitHub repo ─────────────────────────────────────────
async function fetchLiveBench() {
  const urls = [
    'https://raw.githubusercontent.com/LiveBench/LiveBench/main/leaderboard.csv',
    'https://raw.githubusercontent.com/LiveBench/LiveBench/main/docs/leaderboard.csv',
  ];
  for (const u of urls) {
    const r = await fetch(u);
    if (r.ok) return parseCSV(await r.text());
  }
  throw new Error('no leaderboard.csv in LiveBench repo');
}

// ─── Merge into {chat, code, image, video} ─────────────────────────────────

function merge({ openrouter, aider, arena, livebench, prevSnapshot }) {
  const out = { chat: [], code: [], image: [], video: [] };
  const chatMap = new Map(), codeMap = new Map();

  // arena.ai — authoritative Elo for all 4 categories
  const arenaCatMap = { chat: 'text', code: 'code', image: 'image', video: 'video' };
  for (const [cat, arenaKey] of Object.entries(arenaCatMap)) {
    const entries = arena?.[arenaKey];
    if (!entries?.length) continue;
    for (const e of entries) {
      const name = e.modelDisplayName || e.modelName;
      if (!name) continue;
      const elo = Math.round(parseFloat(e.rating) || 0);
      if (!elo) continue;
      const org = e.modelOrganization || guessOrg(name);
      const votes = parseInt(e.votes) || 0;
      const row = mkRow(slug(name), name, org, elo, votes, cat);
      if (e.inputPricePerMillion != null || e.outputPricePerMillion != null) {
        row.pricing = {
          prompt: e.inputPricePerMillion,
          completion: e.outputPricePerMillion,
          perImage: e.pricePerImage,
          perSecond: e.pricePerSecond,
        };
      }
      if (e.contextLength) row.context = e.contextLength;
      out[cat].push(row);
      if (cat === 'chat') chatMap.set(norm(name), row);
      if (cat === 'code') codeMap.set(norm(name), row);
    }
  }

  // LiveBench — overlay chat + code if columns present
  if (livebench?.length) {
    const [header, ...body] = livebench;
    const ci = (n) => header.findIndex(h => h.toLowerCase().trim() === n);
    const iName = ci('model');
    const iAvg = ci('global average');
    const iCode = ci('coding average');
    if (iName > -1) {
      for (const r of body) {
        const name = (r[iName] || '').trim(); if (!name) continue;
        const avg = iAvg > -1 ? parseFloat(r[iAvg]) : 0;
        const code = iCode > -1 ? parseFloat(r[iCode]) : 0;
        const org = guessOrg(name);
        if (code) {
          const row = mkRow(slug(name), name, org, Math.round(code * 10), 0, 'code');
          out.code.push(row);
          codeMap.set(norm(name), row);
        }
        if (avg && !chatMap.has(norm(name))) {
          out.chat.push(mkRow(slug(name), name, org, Math.round(avg * 10), 0, 'chat'));
        }
      }
    }
  }

  // Aider polyglot — code rankings (pass_rate_2 is %)
  if (aider?.length) {
    for (const e of aider) {
      const name = e.model || e.dirname; if (!name) continue;
      const rate = parseFloat(e.pass_rate_2 ?? e.pass_rate_1 ?? e.pass_rate); if (!rate) continue;
      const cleanName = name.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/--.+$/, '');
      const org = guessOrg(cleanName);
      const ex = codeMap.get(norm(cleanName));
      const score = Math.round(rate * 10);
      if (ex) { ex.scores.code = Math.max(ex.scores.code, score); }
      else {
        const row = mkRow(slug(cleanName), cleanName, org, score, 0, 'code');
        out.code.push(row); codeMap.set(norm(cleanName), row);
      }
    }
  }

  // OpenRouter — catalog enrichment (pricing, context)
  if (openrouter?.length) {
    const orMap = new Map(openrouter.map(m => [norm(m.name || m.id), m]));
    for (const cat of ['chat', 'code']) {
      for (const m of out[cat]) {
        const match = orMap.get(norm(m.name)) || orMap.get(norm(m.id));
        if (match) { m.context = match.context_length; m.pricing = match.pricing; }
      }
    }
  }

  // Dedup by id, sort
  for (const cat of ['chat', 'code', 'image', 'video']) {
    const seen = new Map();
    for (const m of out[cat]) {
      const ex = seen.get(m.id);
      if (!ex || (m.scores[cat] || 0) > (ex.scores[cat] || 0)) seen.set(m.id, m);
    }
    out[cat] = Array.from(seen.values()).sort((a, b) => b.scores[cat] - a.scores[cat]);
  }

  // Delta vs previous snapshot (rolling weekly)
  if (prevSnapshot) {
    for (const cat of ['chat', 'code', 'image', 'video']) {
      for (const m of out[cat]) {
        const p = prevSnapshot[`${cat}:${m.id}`];
        if (typeof p === 'number') m.delta = m.scores[cat] - p;
      }
    }
  }

  return out;
}

function guessOrg(name) {
  const n = name.toLowerCase();
  if (n.includes('gpt') || n.includes('o1') || n.includes('o3') || n.includes('o4') || n.includes('dalle')) return 'OpenAI';
  if (n.includes('claude')) return 'Anthropic';
  if (n.includes('gemini') || n.includes('gemma') || n.includes('imagen') || n.includes('veo')) return 'Google';
  if (n.includes('grok')) return 'xAI';
  if (n.includes('deepseek')) return 'DeepSeek';
  if (n.includes('llama')) return 'Meta';
  if (n.includes('mistral') || n.includes('mixtral') || n.includes('pixtral')) return 'Mistral AI';
  if (n.includes('qwen')) return 'Qwen';
  if (n.includes('command')) return 'Cohere';
  if (n.includes('phi')) return 'Microsoft';
  if (n.includes('nova')) return 'Amazon';
  if (n.includes('kimi')) return 'Moonshot';
  if (n.includes('sora')) return 'OpenAI';
  if (n.includes('flux')) return 'Black Forest Labs';
  return 'Unknown';
}
function mkRow(id, name, org, score, votes, cat) {
  return { id, name, org, color: ORG_COLOR[org] || '#888', votes: votes || 0, delta: 0, scores: { [cat]: score } };
}
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

function parseCSV(text) {
  const rows = []; let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false; else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { }
      else field += c;
    }
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ─── Main ──────────────────────────────────────────────────────────────────

const outDir = path.resolve('.');
const outFile = path.join(outDir, 'leaderboard.json');
const snapFile = path.join(outDir, 'snapshot.json');

let prevSnapshot = null;
try {
  const snap = JSON.parse(await fs.readFile(snapFile, 'utf8'));
  if (Date.now() - snap.at < 7 * 864e5) prevSnapshot = snap.scores;
} catch { /* first run */ }

console.log('Fetching sources…');
const [openrouter, aider, arena, livebench] = await Promise.all([
  tryFetch('openrouter', fetchOpenRouter),
  tryFetch('aider', fetchAider),
  fetchArenaAll(),
  tryFetch('livebench', fetchLiveBench),
]);

const merged = merge({ openrouter, aider, arena, livebench, prevSnapshot });
const payload = { ...merged, sources, updatedAt: Date.now(), errors };

await fs.writeFile(outFile, JSON.stringify(payload, null, 2) + '\n');
console.log('Wrote', outFile);
console.log(`Results: ${merged.chat.length} chat · ${merged.code.length} code · ${merged.image.length} image · ${merged.video.length} video`);
console.log('Sources:', sources);

// Refresh weekly snapshot
if (!prevSnapshot) {
  const scores = {};
  for (const cat of ['chat', 'code', 'image', 'video'])
    for (const m of merged[cat]) scores[`${cat}:${m.id}`] = m.scores[cat];
  await fs.writeFile(snapFile, JSON.stringify({ at: Date.now(), scores }, null, 2) + '\n');
  console.log('Wrote snapshot.json');
}

if (merged.chat.length === 0 && merged.code.length === 0) {
  console.error('FATAL: no data from any source');
  process.exit(1);
}
