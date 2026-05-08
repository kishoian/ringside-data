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

// ─── Artificial Analysis: scrape SSR'd leaderboards (no API key needed) ────
// AA embeds full model data in Next.js __next_f stream chunks. They publish
// the same data that powers OpenRouter's "Intelligence Index" ranking — so
// we match what blogs & X accounts reference when calling out "newest top model".
//
// Pages we tap:
//   /leaderboards/models — LLMs, fields: intelligenceIndex, codingIndex, …
//   /image/models        — image models, field: qualityElo
//   /video/models        — video models, field: qualityElo
//
// Scales are intentionally different per page. We surface them as-is rather
// than normalizing so you can trust the numbers against AA's site directly.

function extractAAObjects(html, markerKey) {
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,"(.*?)"\]\)/gs)].map(m => m[1]);
  // Unescape once: JSON-escaped in chunk strings
  const big = chunks.join('').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const markerRe = new RegExp(`"${markerKey}"\\s*:`, 'g');
  const out = [];
  const seen = new Set();
  let m;
  while ((m = markerRe.exec(big))) {
    // Walk back to object start
    let depth = 0, start = -1;
    for (let i = m.index; i >= 0; i--) {
      const c = big[i];
      if (c === '}') depth++;
      else if (c === '{') {
        if (depth === 0) { start = i; break; }
        depth--;
      }
    }
    if (start < 0) continue;
    if (seen.has(start)) continue;
    seen.add(start);

    // Walk forward honoring strings/escapes
    let end = -1, inStr = false, esc = false;
    depth = 0;
    for (let j = start; j < big.length; j++) {
      const c = big[j];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end < 0) continue;
    try {
      const obj = JSON.parse(big.slice(start, end + 1));
      if (obj && obj[markerKey] !== undefined) out.push(obj);
    } catch { /* skip malformed slice */ }
  }
  return out;
}

async function fetchAA(url, markerKey) {
  const res = await fetch(url, {
    headers: {
      // Some Cloudflare-fronted sites 403 a generic Mozilla UA. Use a real
      // Chrome UA + Accept headers so we look like a normal browser.
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
  });
  const html = await res.text();
  if (!res.ok) throw new Error(`http ${res.status} (size ${html.length})`);
  if (!html || html.length < 50000) throw new Error('html too small: ' + html.length);
  const models = extractAAObjects(html, markerKey);
  if (!models.length) throw new Error('no models extracted');
  return models;
}

async function fetchAAVideo() {
  // Video page nests elo inside an `elos` array (one per resolution variant).
  // Marker `elos` selects the outer model object; we pick the max elo below.
  const res = await fetch('https://artificialanalysis.ai/video/models', {
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
  });
  const html = await res.text();
  if (!res.ok) throw new Error(`http ${res.status}`);
  if (!html || html.length < 50000) throw new Error('html too small');
  const models = extractAAObjects(html, 'elos')
    .filter(m => Array.isArray(m.elos) && m.elos.length && m.name);
  if (!models.length) throw new Error('no video models extracted');
  for (const m of models) {
    m.qualityElo = Math.max(...m.elos.map(e => e.elo || 0));
  }
  return models;
}

// ─── arena.ai — human voting Elo, kept as supplementary signal ─────────────
async function fetchArena(slug) {
  const res = await fetch(`https://arena.ai/leaderboard/${slug}`, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
  });
  const html = await res.text();
  if (!res.ok) throw new Error(`http ${res.status}`);
  if (!html || html.length < 10000) throw new Error('html too small');
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,"(.*?)"\]\)/gs)].map(m => m[1]);
  const big = chunks.join('');
  const entries = [];
  const re = /\{\\"rank\\":\d+[^{}]*?\\"rating\\":[\d.]+[^{}]*?\}/g;
  let m;
  while ((m = re.exec(big))) {
    try {
      const obj = JSON.parse(m[0].replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
      entries.push(obj);
    } catch { /* skip */ }
  }
  if (!entries.length) throw new Error('no entries');
  return entries;
}

async function fetchArenaAll() {
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
  return { chat: text, code, image, video };
}

async function fetchAAAll() {
  const [llm, image, video] = await Promise.all([
    fetchAA('https://artificialanalysis.ai/leaderboards/models', 'intelligenceIndex').catch(e => (sources.aa_llm = 'err: ' + e.message, null)),
    fetchAA('https://artificialanalysis.ai/image/models', 'qualityElo').catch(e => (sources.aa_image = 'err: ' + e.message, null)),
    fetchAAVideo().catch(e => (sources.aa_video = 'err: ' + e.message, null)),
  ]);
  if (llm)   sources.aa_llm = `ok (${llm.length})`;
  if (image) sources.aa_image = `ok (${image.length})`;
  if (video) sources.aa_video = `ok (${video.length})`;
  return { llm, image, video };
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

function merge({ openrouter, aa, arena, prevSnapshot }) {
  const out = { chat: [], code: [], image: [], video: [] };

  // LLM page → chat (intelligenceIndex) + code (codingIndex)
  if (aa?.llm?.length) {
    for (const m of aa.llm) {
      const name = m.name || m.shortName || m.slug;
      if (!name) continue;
      const org = m.modelCreatorName || m.modelCreator?.name || 'Unknown';
      const color = m.modelCreatorColor || ORG_COLOR[org] || '#888';
      const logo = m.modelCreatorLogo ? `https://artificialanalysis.ai/img/logos/${m.modelCreatorLogo}` : null;

      const chat = m.intelligenceIndex;
      const code = m.codingIndex;
      if (typeof chat === 'number' && chat > 0) {
        const row = mkAARow(name, org, color, logo, chat, 'chat', m);
        out.chat.push(row);
      }
      if (typeof code === 'number' && code > 0) {
        const row = mkAARow(name, org, color, logo, code, 'code', m);
        out.code.push(row);
      }
    }
  }

  // Image page → qualityElo
  if (aa?.image?.length) {
    for (const m of aa.image) {
      const name = m.name || m.shortName;
      if (!name) continue;
      const org = m.creator?.name || m.modelCreatorName || 'Unknown';
      const color = m.creator?.color || ORG_COLOR[org] || '#888';
      const logo = m.creator?.logoSmall ? `https://artificialanalysis.ai${m.creator.logoSmall}` : null;
      const elo = Math.round(m.qualityElo || 0);
      if (!elo) continue;
      out.image.push(mkAARow(name, org, color, logo, elo, 'image', m));
    }
  }

  // Video page → qualityElo
  if (aa?.video?.length) {
    for (const m of aa.video) {
      const name = m.name || m.shortName;
      if (!name) continue;
      const org = m.creator?.name || m.modelCreatorName || 'Unknown';
      const color = m.creator?.color || ORG_COLOR[org] || '#888';
      const logo = m.creator?.logoSmall ? `https://artificialanalysis.ai${m.creator.logoSmall}` : null;
      const elo = Math.round(m.qualityElo || 0);
      if (!elo) continue;
      out.video.push(mkAARow(name, org, color, logo, elo, 'video', m));
    }
  }

  // Arena.ai — human-vote Elo attached as supplementary `arenaElo` field.
  // Match via multi-alias (canonical name + parenthesized fragments) so
  // marketing names cross-link with model IDs.
  for (const cat of ['chat', 'code', 'image', 'video']) {
    const arenaEntries = arena?.[cat];
    if (!arenaEntries?.length) continue;
    const arenaMap = new Map();
    for (const e of arenaEntries) {
      const n = e.modelDisplayName || e.modelName;
      if (!n) continue;
      const elo = Math.round(parseFloat(e.rating) || 0);
      if (!elo) continue;
      for (const k of aliases(n)) {
        if (!arenaMap.has(k) || arenaMap.get(k) < elo) arenaMap.set(k, elo);
      }
    }
    for (const m of out[cat]) {
      for (const a of aliases(m.name)) {
        const e = arenaMap.get(a);
        if (e) { m.arenaElo = e; break; }
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

  // Dedup exact ID collisions within each category (preserves variants like
  // gpt-5 (high) / gpt-5 (medium) as separate rows).
  for (const cat of ['chat', 'code', 'image', 'video']) {
    const seen = new Map();
    for (const m of out[cat]) {
      const ex = seen.get(m.id);
      if (!ex || (m.scores[cat] || 0) > (ex.scores[cat] || 0)) seen.set(m.id, m);
    }
    out[cat] = Array.from(seen.values()).sort((a, b) => b.scores[cat] - a.scores[cat]);
  }

  // Cross-source matching: for each row, find the same model in other
  // categories by canonical (variant-stripped) name and attach those scores
  // as `alts`. Lets the UI show a model's Aider % next to its arena Elo and
  // vice versa without merging the rows.
  const canonicalIndex = new Map(); // canonical → [{cat, score, name}]
  for (const cat of ['chat', 'code', 'image', 'video']) {
    for (const m of out[cat]) {
      const key = canonical(m.name);
      if (!key) continue;
      if (!canonicalIndex.has(key)) canonicalIndex.set(key, []);
      canonicalIndex.get(key).push({ cat, score: m.scores[cat], name: m.name });
    }
  }
  for (const cat of ['chat', 'code', 'image', 'video']) {
    for (const m of out[cat]) {
      const key = canonical(m.name);
      const matches = canonicalIndex.get(key) || [];
      const alts = {};
      for (const mt of matches) {
        if (mt.cat === cat) continue;
        // Keep best score per alt category (a model may have multiple variants
        // in the same other category — pick the highest).
        if (alts[mt.cat] == null || mt.score > alts[mt.cat]) alts[mt.cat] = mt.score;
      }
      if (Object.keys(alts).length) m.alts = alts;
    }
  }

  // Delta vs previous snapshot (rolling weekly). Keyed on canonical name so
  // the key is stable even if the raw id changes between script versions.
  if (prevSnapshot) {
    for (const cat of ['chat', 'code', 'image', 'video']) {
      for (const m of out[cat]) {
        const p = prevSnapshot[`${cat}:${canonical(m.name)}`];
        if (typeof p === 'number') m.delta = Math.round((m.scores[cat] - p) * 10) / 10;
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

function mkAARow(name, org, color, logo, score, cat, raw) {
  const row = {
    id: slug(name),
    name, org, color,
    votes: 0, // AA is benchmark-based, not voting — keep field for schema parity
    delta: 0,
    scores: { [cat]: Math.round(score * 10) / 10 },
  };
  if (logo) row.logo = logo;
  if (raw.releaseDate) row.releaseDate = raw.releaseDate;
  // Pricing for LLMs
  if (raw.price1mInputTokens != null || raw.price1mOutputTokens != null) {
    row.pricing = {
      prompt: raw.price1mInputTokens,
      completion: raw.price1mOutputTokens,
      blended: raw.price1mBlended3To1,
    };
  }
  return row;
}

// Strip variant markers to group the same underlying model together.
// Aggressive: any parenthetical/bracket annotation is treated as a variant tag.
// Examples collapsed to the same canonical id:
//   claude-opus-4-7-thinking / claude-opus-4-7 (no think)            → claude-opus-4-7
//   gpt-5 (high) / gpt-5 (medium) / gpt-5 (low)                      → gpt-5
//   Claude Opus 4.7 (Adaptive Reasoning, Max Effort) / (Non-reason.) → claude-opus-4-7
//   Gemini 3.1 Pro Preview / gemini-3.1-pro-preview                  → gemini-3-1-pro-preview
const VARIANT_RE = /\s*[\(\[][^)\]]*[\)\]]/g;
const SUFFIX_RE = /[-_\s](?:thinking|high|medium|low|xhigh|no-?think|reasoner|non-reasoning)$/i;

function canonical(name) {
  return String(name || '')
    .replace(VARIANT_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(SUFFIX_RE, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// Multiple aliases for the same model — handles cross-source naming where
// AA uses marketing names ("Nano Banana Pro") while arena uses model IDs
// ("gemini-3-pro-image-preview"). Each parenthesized fragment also becomes
// a candidate alias so they cross-match.
function aliases(name) {
  if (!name) return [];
  const set = new Set();
  set.add(canonical(name));
  for (const m of String(name).matchAll(/[\(\[]([^)\]]+)[\)\]]/g)) {
    const inner = m[1].trim();
    if (inner.length > 2) set.add(canonical(inner));
  }
  return [...set].filter(Boolean);
}

function displayName(name) {
  // Strip variant markers but keep nice casing from the original name.
  return String(name || '').replace(VARIANT_RE, '').replace(SUFFIX_RE, '').replace(/\s+/g, ' ').trim();
}

function variantLabel(name, score) {
  const m = String(name || '').match(VARIANT_RE);
  if (!m) return null;
  return { label: m.join(' ').replace(/[\(\)\[\]]/g, '').trim(), score };
}

// ─── In-page mention dictionary ────────────────────────────────────────────
// Builds a deduplicated list of model display names with best score per
// category and per-cat ranks. Consumed by the extension's content script
// to enrich AI model mentions on web pages with their AA Intelligence Index.
//
// Filtering rules — chosen to minimize false positives across the open web:
//   • Skip names < 3 chars
//   • Skip bare single-word names (Claude, GPT, Llama) unless on the
//     ALWAYS_OK_SINGLE allow-list (Sora, Midjourney, DALL-E etc.)
//   • Single-word names without digits & not on allow-list → skipped
//   • Sort by name length DESC so longest-match wins (Claude 3.5 Sonnet
//     before Claude 3.5 before Claude)
const ALWAYS_OK_SINGLE = new Set([
  'sora', 'midjourney', 'dall-e', 'dalle', 'flux', 'imagen', 'veo', 'kling',
  'runway', 'pika', 'suno', 'udio', 'luma', 'ideogram', 'recraft', 'firefly',
  'mochi', 'wan', 'hailuo', 'sana', 'lumiere',
]);

function shouldIncludeName(display) {
  if (!display || display.length < 3) return false;
  const lower = display.toLowerCase();
  const hasDigit = /\d/.test(display);
  const wordCount = display.split(/\s+/).length;
  if (wordCount === 1) {
    return hasDigit || ALWAYS_OK_SINGLE.has(lower);
  }
  // Multi-word — accept (covers "Claude Sonnet 4.5", "Gemini 2.5 Pro" etc.)
  return true;
}

// Generate alternate textual forms ("aliases") that should map back to the
// same model entry. Catches casual web-page phrasing — articles often write
// "Sonnet 4.6", "K2.6" or "GPT 5.5" instead of the full canonical name.
//
// Heuristics — conservative to avoid false positives:
//   • Word-order swap for "<Vendor> <Adjective> <Version>" → "<Vendor> <Version> <Adjective>"
//     ("Claude Sonnet 4.6" → "Claude 4.6 Sonnet")
//   • Strip leading vendor token if remainder still contains a digit
//     ("Claude Sonnet 4.6" → "Sonnet 4.6"; "Kimi K2.6" → "K2.6"; "Llama 4" stays — no shorter form)
//   • Common dash/space variants for digits: "GPT-5.5" → "GPT 5.5"
//   • Skip alias if the resulting string is < 3 chars OR is just a digit/version w/o letters
const VENDOR_PREFIXES = new Set([
  'openai', 'anthropic', 'google', 'meta', 'xai', 'deepseek', 'mistral',
  'mistralai', 'qwen', 'alibaba', 'cohere', 'microsoft', 'amazon',
  'midjourney', 'kimi', 'moonshot', 'minimax', 'recraft', 'ideogram',
  'stabilityai', 'stability', 'blackforestlabs', 'runway', 'luma', 'pika',
  '01ai',
]);

function aliasesFor(displayName) {
  if (!displayName) return [];
  const out = new Set();
  out.add(displayName);

  const tokens = displayName.split(/\s+/);

  // 1. Word-order swap: "Claude Sonnet 4.6" → "Claude 4.6 Sonnet"
  if (tokens.length === 3 && /^[A-Za-z]+$/.test(tokens[1]) && /\d/.test(tokens[2])) {
    out.add(`${tokens[0]} ${tokens[2]} ${tokens[1]}`);
  }
  // Reverse: "Claude 4.6 Sonnet" → "Claude Sonnet 4.6"
  if (tokens.length === 3 && /\d/.test(tokens[1]) && /^[A-Za-z]+$/.test(tokens[2])) {
    out.add(`${tokens[0]} ${tokens[2]} ${tokens[1]}`);
  }

  // 2. Drop leading vendor token if remainder has a digit AND is multi-char
  //    "Kimi K2.6" → "K2.6"
  //    "Claude Sonnet 4.6" → "Sonnet 4.6" (only if it has version digit too)
  if (tokens.length >= 2) {
    const head = tokens[0].toLowerCase().replace(/[^a-z0-9]/g, '');
    if (VENDOR_PREFIXES.has(head)) {
      const tail = tokens.slice(1).join(' ');
      if (tail.length >= 3 && /\d/.test(tail)) {
        out.add(tail);
      }
    }
  }

  // 3. Punctuation variants on digit-bearing tokens
  //    "GPT-5.5" → "GPT 5.5", "GPT5.5"
  for (const variant of [...out]) {
    if (/[A-Za-z]\d/.test(variant) || /-\d/.test(variant)) {
      const noDash = variant.replace(/-(\d)/g, ' $1');
      const tight = variant.replace(/-(\d)/g, '$1');
      if (noDash !== variant) out.add(noDash);
      if (tight !== variant && /\d.*\d/.test(tight)) out.add(tight);
    }
  }

  // Filter: drop too-short or letter-less aliases
  return [...out].filter(
    (a) => a.length >= 3 && /[A-Za-z]/.test(a) && /[A-Za-z]\s*[A-Za-z\d]|[A-Za-z]\d|\d.*[A-Za-z]/.test(a)
  );
}

function buildDict(merged) {
  const map = new Map();
  for (const cat of ['chat', 'code', 'image', 'video']) {
    for (const m of merged[cat]) {
      const display = displayName(m.name);
      const key = canonical(m.name);
      if (!key || !shouldIncludeName(display)) continue;
      let entry = map.get(key);
      if (!entry) {
        entry = {
          key,
          name: display,
          org: m.org,
          color: m.color,
          scores: {},
          ranks: {},
        };
        if (m.logo) entry.logo = m.logo;
        if (m.releaseDate) entry.releaseDate = m.releaseDate;
        map.set(key, entry);
      }
      const sc = m.scores[cat];
      if (sc != null && (entry.scores[cat] == null || sc > entry.scores[cat])) {
        entry.scores[cat] = sc;
      }
      // Track latest release date across variants
      if (m.releaseDate && (!entry.releaseDate || m.releaseDate > entry.releaseDate)) {
        entry.releaseDate = m.releaseDate;
      }
    }
  }
  // Generate aliases per entry
  for (const e of map.values()) {
    const al = aliasesFor(e.name).filter((a) => a !== e.name);
    if (al.length) e.aliases = al;
  }
  // Compute per-category ranks
  for (const cat of ['chat', 'code', 'image', 'video']) {
    const ranked = [...map.values()]
      .filter(e => e.scores[cat] != null)
      .sort((a, b) => b.scores[cat] - a.scores[cat]);
    ranked.forEach((e, i) => { e.ranks[cat] = i + 1; });
  }
  // Sort dict by name length DESC for longest-match-first regex assembly
  return [...map.values()]
    .filter(e => Object.keys(e.scores).length > 0)
    .sort((a, b) => b.name.length - a.name.length);
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
const [openrouter, aa, arena] = await Promise.all([
  tryFetch('openrouter', fetchOpenRouter),
  fetchAAAll(),
  fetchArenaAll(),
]);

const merged = merge({ openrouter, aa, arena, prevSnapshot });
const dict = buildDict(merged);
const payload = { ...merged, dict, sources, updatedAt: Date.now(), errors };

await fs.writeFile(outFile, JSON.stringify(payload, null, 2) + '\n');
console.log('Wrote', outFile);
console.log(`Results: ${merged.chat.length} chat · ${merged.code.length} code · ${merged.image.length} image · ${merged.video.length} video`);
console.log('Sources:', sources);

// Refresh weekly snapshot
if (!prevSnapshot) {
  const scores = {};
  for (const cat of ['chat', 'code', 'image', 'video']) {
    // For a given canonical name, keep the best score across variants —
    // matches how alts are computed so snapshot compares apples to apples.
    for (const m of merged[cat]) {
      const key = `${cat}:${canonical(m.name)}`;
      if (scores[key] == null || m.scores[cat] > scores[key]) scores[key] = m.scores[cat];
    }
  }
  await fs.writeFile(snapFile, JSON.stringify({ at: Date.now(), scores }, null, 2) + '\n');
  console.log('Wrote snapshot.json');
}

if (merged.chat.length === 0 && merged.code.length === 0 && merged.image.length === 0 && merged.video.length === 0) {
  console.error('FATAL: no data from any source. Errors:', errors);
  console.error('Sources:', sources);
  process.exit(1);
}
