// Decode the actual JSON string in each Next.js Flight chunk. Replacing
// backslashes by hand corrupts quoted names and nested objects.
export function decodeFlight(html) {
  return [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)]
    .map(m => JSON.parse(m[1])).join('');
}

export function extractObjects(html, markerKey) {
  const stream = decodeFlight(html);
  const starts = [];
  const result = [];
  let inString = false, escaped = false;
  for (let i = 0; i < stream.length; i++) {
    const c = stream[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') starts.push(i);
    else if (c === '}' && starts.length) {
      const start = starts.pop();
      const slice = stream.slice(start, i + 1);
      if (!slice.includes(`"${markerKey}"`)) continue;
      try {
        const obj = JSON.parse(slice);
        if (Object.hasOwn(obj, markerKey)) result.push(obj);
      } catch { /* Flight records may contain non-JSON references. */ }
    }
  }
  return result;
}

export function extractBoard(html, dataKey) {
  const props = extractObjects(html, dataKey).find(p => typeof p[dataKey] === 'string' && p[dataKey].startsWith('$Q'));
  if (!props) throw new Error(`Missing board data: ${dataKey}`);
  const id = props[dataKey].slice(2);
  const line = decodeFlight(html).split('\n').find(line => line.startsWith(id + ':'));
  if (!line) throw new Error(`Missing Flight record: ${id}`);
  const categories = new Map(JSON.parse(line.slice(id.length + 1)));
  const rows = categories.get(null);
  if (!Array.isArray(rows)) throw new Error('Missing overall rating pool');
  return rows.map(r => r.values).filter(m => m?.name && Number.isFinite(m.elo) && m.isCurrent !== false);
}

export const CATEGORY_META = {
  chat: { label: 'AA Intelligence Index', url: 'https://artificialanalysis.ai/leaderboards/models' },
  code: { label: 'Terminal-Bench 4.0 (%)', url: 'https://artificialanalysis.ai/evaluations/terminalbench-4-0' },
  image: { label: 'AA Text-to-Image Elo', url: 'https://artificialanalysis.ai/image/leaderboard/text-to-image' },
  video: { label: 'AA Text-to-Video Elo (audio)', url: 'https://artificialanalysis.ai/video/leaderboard/text-to-video' },
};

// A successful HTTP request does not guarantee a usable leaderboard.
// Validate before overwriting the last published data or weekly snapshot.
export function validateCategories(next, previous = {}) {
  for (const cat of Object.keys(CATEGORY_META)) {
    const rows = next[cat];
    if (!Array.isArray(rows) || !rows.length) throw new Error(`Missing primary category: ${cat}`);
    if (rows.some(m => !m.id || !m.name || !Number.isFinite(m.scores?.[cat]))) {
      throw new Error(`Invalid model in category: ${cat}`);
    }
    if (previous[cat]?.length && rows.length < previous[cat].length * 0.5) {
      throw new Error(`Unexpected loss of models in ${cat}: ${previous[cat].length} -> ${rows.length}`);
    }
  }
}
