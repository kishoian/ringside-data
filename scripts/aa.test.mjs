import test from 'node:test';
import assert from 'node:assert/strict';
import { extractObjects, extractBoard, validateCategories } from './aa.mjs';

function flight(...chunks) {
  return chunks.map(s => `<script>self.__next_f.push([1,${JSON.stringify(s)}])</script>`).join('');
}

test('Flight decoding preserves escaped names, braces and split objects', () => {
  const row = { name: 'Model "quoted" {test} \\ path', intelligenceIndex: 0, creator: { name: 'Org' } };
  const json = JSON.stringify({ models: [row] });
  const html = flight(json.slice(0, 35), json.slice(35));
  assert.deepEqual(extractObjects(html, 'intelligenceIndex'), [row]);
});

test('selects overall audio pool without mixing other categories or silent ratings', () => {
  const row = { name: 'Wan 3.0', elo: 1174, isCurrent: true };
  const old = { name: 'Retired model', elo: 1300, isCurrent: false };
  const stream = '1:' + JSON.stringify({ withAudioData: '$Q3a', withoutAudioData: '$Q4a' }) + '\n' +
    '3a:' + JSON.stringify([[null, [{ values: row }, { values: old }]], ['other-category', [{ values: { name: 'Wrong pool', elo: 1900 } }]]]) + '\n' +
    '4a:' + JSON.stringify([[null, [{ values: { name: 'Wan 3.0', elo: 1135 } }]]]) + '\n';
  assert.deepEqual(extractBoard(flight(stream), 'withAudioData'), [row]);
  assert.throws(() => extractBoard(flight(stream), 'initialData'), /Missing board/);
});

test('rejects missing categories, invalid scores and catastrophic row loss', () => {
  const valid = Object.fromEntries(['chat', 'code', 'image', 'video'].map(cat => [cat, [{ id: 'model', name: 'Model', scores: { [cat]: 0 } }]]));
  assert.doesNotThrow(() => validateCategories(valid));
  assert.throws(() => validateCategories({ ...valid, code: [] }), /code/);
  assert.throws(() => validateCategories({ ...valid, video: [{ id: 'x', name: 'x', scores: { video: NaN } }] }), /video/);
  assert.throws(() => validateCategories(valid, { chat: Array(10).fill({}) }), /loss of models/);
  const old = { code: Array(133).fill({}) };
  assert.throws(() => validateCategories(valid, old), /loss of models in code/);
  assert.doesNotThrow(() => validateCategories(valid, old, { rebaseCode: true }));
  assert.throws(() => validateCategories({ ...valid, code: [] }, old, { rebaseCode: true }), /Missing primary category: code/);
});
