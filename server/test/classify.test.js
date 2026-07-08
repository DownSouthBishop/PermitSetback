// Regression test for a real misclassification: plain substring matching
// classified "converting the garage into a living space" as a pool project,
// because "space" contains "spa". classifyTrade now matches on word
// boundaries instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTrade } from '../classify.js';

test('a garage conversion is not misclassified as a pool via "space" containing "spa"', () => {
  assert.equal(classifyTrade('Converting the garage into a living space, new construction'), 'garage/adu');
});

test('an actual pool project still classifies as pool', () => {
  assert.equal(classifyTrade('New 15x30 ft inground pool, fenced backyard'), 'pool');
});

test('"pv" matches as a whole word', () => {
  assert.equal(classifyTrade('Installing rooftop PV panels'), 'solar');
});

test('an unrecognized project type falls back to other', () => {
  assert.equal(classifyTrade('Building a treehouse for the kids'), 'other');
});
