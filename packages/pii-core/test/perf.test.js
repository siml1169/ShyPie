import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { createRedactor } from '../index.js';
import { makeLargeDocument } from './helpers/fixtures.mjs';

/**
 * Contract acceptance: a ~50k-char synthetic document must redact without
 * pathological backtracking. The document is generated from the deterministic
 * synthetic fixture generator (no real data). Measurement is taken after one
 * warm-up redact because the first call also pays JIT/regex compilation cost.
 */
test('50k-char synthetic document redacts under the 50 ms budget (warm)', () => {
  const doc = makeLargeDocument(50000);
  assert.ok(doc.length >= 50000 && doc.length < 62000, 'fixture length: ' + doc.length);

  const r = createRedactor({ key: 'perf-session-key', allowWords: ['Max Mustermann'] });
  r.redact(doc); // warm-up

  const runs = [];
  let lastHits = 0;
  for (let i = 0; i < 5; i++) {
    const started = performance.now();
    const out = r.redact(doc);
    runs.push(performance.now() - started);
    lastHits = out.hits.length;
    assert.equal(r.redact(out.text).changed, false, 'redaction must be idempotent');
  }
  const best = Math.min(...runs);
  const median = [...runs].sort((a, b) => a - b)[Math.floor(runs.length / 2)];

  // eslint-disable-next-line no-console
  console.log(
    '[perf] ' + doc.length + '-char synthetic doc: best ' + best.toFixed(2) + ' ms, median ' +
      median.toFixed(2) + ' ms, runs [' + runs.map((t) => t.toFixed(2)).join(', ') + '], ' + lastHits + ' hits',
  );

  assert.ok(lastHits > 500, 'expected many hits on the synthetic doc, got ' + lastHits);
  assert.ok(best < 50, 'warm redact exceeded 50 ms: ' + best.toFixed(2) + ' ms');
});

test('clean 50k document (no PII) also stays within budget', () => {
  let clean = '';
  while (clean.length < 50000) {
    clean += 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt. ';
  }
  const r = createRedactor({ key: 'perf-session-key' });
  r.redact(clean); // warm-up
  const started = performance.now();
  const out = r.redact(clean);
  const elapsed = performance.now() - started;

  // eslint-disable-next-line no-console
  console.log('[perf] clean ' + clean.length + '-char doc: ' + elapsed.toFixed(2) + ' ms, ' + out.hits.length + ' hits');

  assert.equal(out.changed, false);
  assert.ok(elapsed < 50, 'clean-doc scan exceeded 50 ms: ' + elapsed.toFixed(2) + ' ms');
});
