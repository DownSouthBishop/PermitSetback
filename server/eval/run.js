// Eval harness for generateRoadmap() (server/llm.js) — the prompt every
// other module builds on. Calls the real Anthropic API for every case in
// cases.json (small real cost, ~15 calls), scores each response against a
// rubric, and writes a timestamped report so future prompt edits have a
// baseline to compare against instead of "it looks fine to me."
//
// This is NOT part of `npm test` (server/test/) on purpose — it's slow,
// costs real API calls, and isn't deterministic. Run it by hand:
//   cd server && node --env-file=.env eval/run.js
//   node --env-file=.env eval/run.js --compare eval/baseline.json
//
// Scope note: covers generateRoadmap only. Feasibility/risk/cost/documents
// each have their own system prompt and would want their own cases.json —
// this is the template to copy, not the only eval this app should ever have.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generateRoadmap } from '../llm.js';
import { classifyTrade } from '../classify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { cases } = JSON.parse(readFileSync(join(__dirname, 'cases.json'), 'utf8'));

const HEDGE_WORDS = ['typically', 'commonly', 'generally', 'often', 'may', 'might', 'likely', 'usually', 'check', 'confirm', 'verify', 'consult', 'varies', 'depending'];
const CITATION_PATTERN = /\b(section|chapter|code|statute|ordinance|article)\s+\d+/gi;

// Flags citation-like patterns ("Section 454") with no hedge word in the
// surrounding ~80 characters — not an auto-fail (it might still be right),
// just something a human should eyeball before trusting it.
function findUnhedgedCitations(text) {
  const hits = [];
  let m;
  CITATION_PATTERN.lastIndex = 0;
  while ((m = CITATION_PATTERN.exec(text))) {
    const windowStart = Math.max(0, m.index - 80);
    const windowEnd = Math.min(text.length, m.index + m[0].length + 80);
    const window = text.slice(windowStart, windowEnd).toLowerCase();
    const hedged = HEDGE_WORDS.some(w => window.includes(w));
    if (!hedged) hits.push(text.slice(windowStart, windowEnd).trim());
  }
  return hits;
}

function allText(result) {
  const agencyText = (result.agencies || []).map(a => `${a.name} ${a.detail}`).join(' ');
  const flagText = (result.flags || []).join(' ');
  const riskText = (result.risks || []).join(' ');
  return [agencyText, flagText, riskText, result.narrative || '', result.timelineNote || ''].join(' ');
}

function matchesThemeGroup(text, group) {
  const lower = text.toLowerCase();
  return group.some(kw => lower.includes(kw.toLowerCase()));
}

async function runCase(testCase) {
  const trade = classifyTrade(testCase.description);
  const started = Date.now();
  const { provider, result } = await generateRoadmap(testCase.location, testCase.description, trade);
  const elapsedMs = Date.now() - started;

  const checks = [];

  if (testCase.expectUnrecognized) {
    checks.push({ name: 'flags as unrecognized', pass: result.unrecognized === true });
    return { id: testCase.id, provider, elapsedMs, result, checks, allPass: checks.every(c => c.pass) };
  }

  checks.push({ name: 'did not incorrectly flag as unrecognized', pass: !result.unrecognized });
  if (result.unrecognized) {
    return { id: testCase.id, provider, elapsedMs, result, checks, allPass: false };
  }

  checks.push({ name: 'agencies count in [3,6]', pass: result.agencies.length >= 3 && result.agencies.length <= 6, detail: result.agencies.length });
  checks.push({ name: 'flags count in [3,6]', pass: result.flags.length >= 3 && result.flags.length <= 6, detail: result.flags.length });
  checks.push({ name: 'risks count in [3,6]', pass: result.risks.length >= 3 && result.risks.length <= 6, detail: result.risks.length });

  const text = allText(result);
  for (const group of testCase.themeGroups) {
    checks.push({ name: `mentions one of [${group.join('/')}]`, pass: matchesThemeGroup(text, group) });
  }

  const unhedged = findUnhedgedCitations(text);
  checks.push({ name: 'no unhedged specific citations', pass: unhedged.length === 0, detail: unhedged.length ? unhedged : undefined, warningOnly: true });

  const hardChecks = checks.filter(c => !c.warningOnly);
  return { id: testCase.id, provider, elapsedMs, result, checks, allPass: hardChecks.every(c => c.pass) };
}

async function main() {
  const compareArg = process.argv.indexOf('--compare');
  const baseline = compareArg > -1 ? JSON.parse(readFileSync(process.argv[compareArg + 1], 'utf8')) : null;

  // --only id1,id2 — run a subset (e.g. to re-check specific cases after a
  // targeted prompt tweak) instead of paying for and waiting on all 15.
  const onlyArg = process.argv.indexOf('--only');
  const onlyIds = onlyArg > -1 ? process.argv[onlyArg + 1].split(',') : null;
  const casesToRun = onlyIds ? cases.filter(c => onlyIds.includes(c.id)) : cases;

  const results = [];
  for (const testCase of casesToRun) {
    process.stdout.write(`Running ${testCase.id}... `);
    try {
      const r = await runCase(testCase);
      results.push(r);
      console.log(r.allPass ? 'PASS' : 'FAIL');
    } catch (err) {
      results.push({ id: testCase.id, error: err.message, allPass: false, checks: [] });
      console.log(`ERROR (${err.message})`);
    }
  }

  console.log('\n=== Report ===');
  let passCount = 0;
  for (const r of results) {
    if (r.allPass) passCount++;
    const failedChecks = (r.checks || []).filter(c => !c.pass && !c.warningOnly);
    const warnings = (r.checks || []).filter(c => !c.pass && c.warningOnly);
    if (failedChecks.length || warnings.length || r.error) {
      console.log(`\n${r.id}: ${r.allPass ? 'PASS (with warnings)' : 'FAIL'}`);
      if (r.error) console.log(`  ERROR: ${r.error}`);
      for (const c of failedChecks) console.log(`  FAIL: ${c.name}${c.detail !== undefined ? ` (${JSON.stringify(c.detail)})` : ''}`);
      for (const c of warnings) console.log(`  WARN: ${c.name}${c.detail ? ` — ${JSON.stringify(c.detail)}` : ''}`);
    }
  }
  console.log(`\n${passCount}/${results.length} cases passed all hard checks.`);

  if (baseline) {
    // When --only filters to a subset, compare against the matching subset of
    // the baseline, not the baseline's full-suite pass count — otherwise a
    // 3-case run always looks like a regression against a 15-case baseline.
    const baselineSubset = onlyIds ? baseline.results.filter(r => onlyIds.includes(r.id)) : baseline.results;
    const basePassCount = baselineSubset.filter(r => r.allPass).length;
    console.log(`\nBaseline (${baseline.generatedAt}), same ${baselineSubset.length} case(s): ${basePassCount}/${baselineSubset.length} passed.`);
    for (const id of (onlyIds || [])) {
      const before = baselineSubset.find(r => r.id === id);
      const after = results.find(r => r.id === id);
      if (before) console.log(`  ${id}: baseline=${before.allPass ? 'PASS' : 'FAIL'} -> now=${after.allPass ? 'PASS' : 'FAIL'}`);
    }
    console.log(passCount >= basePassCount ? 'No regression vs baseline.' : 'REGRESSION vs baseline — investigate before shipping this prompt change.');
  }

  const outPath = join(__dirname, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), passCount, total: results.length, results }, null, 2));
  console.log(`\nFull report written to ${outPath}`);
}

main();
