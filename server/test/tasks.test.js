// Regression test: a flag whose leading clause is itself a long sentence
// used to produce a task title that was almost the entire opening sentence
// of its own detail — reading as a duplicate, not a label.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortTitleFromFlag } from '../routes/tasks.js';

test('a long leading clause is trimmed to a short, distinct label', () => {
  const flag = 'The garage slab is not a code-compliant floor for living space as-is. It typically lacks a vapor barrier and insulation beneath it.';
  const title = shortTitleFromFlag(flag);
  assert.ok(title.length <= 42, `expected a short label, got ${title.length} chars: "${title}"`);
  assert.ok(title.endsWith('…'), 'expected the trimmed title to end with an ellipsis');
});

test('a short flag is used as-is, no unnecessary truncation', () => {
  assert.equal(shortTitleFromFlag('Setback distance flag'), 'Setback distance flag');
});

test('a flag with an early em-dash clause uses that clause as the title', () => {
  assert.equal(shortTitleFromFlag('Barrier compliance — gate hardware must be on the approved list'), 'Barrier compliance');
});
