// Tests for lib/date-parse.js — the highest-risk pure logic in the app.
// Run with: npm test  (node --test)
//
// Regression anchor: bare YYYY-MM-DD input used to be parsed as UTC midnight
// (`new Date('2026-08-15')`), which in any US timezone is the previous
// evening local — MCP-created tasks landed one day early (review A2).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLooseDate } from '../lib/date-parse.js';

// A fixed reference for chrono-based parses: Wed 2026-06-10, 09:00 local.
const REF = new Date(2026, 5, 10, 9, 0, 0);

test('null / empty / whitespace clear the date', () => {
  for (const input of [null, undefined, '', '   ']) {
    const r = parseLooseDate(input);
    assert.equal(r.ok, true);
    assert.equal(r.iso, null);
  }
});

test('non-string input is rejected, not coerced', () => {
  const r = parseLooseDate(12345);
  assert.equal(r.ok, false);
});

test('bare YYYY-MM-DD is a LOCAL date (not UTC midnight) defaulting to 17:00', () => {
  const r = parseLooseDate('2026-08-15');
  assert.equal(r.ok, true);
  const d = new Date(r.iso);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 7);      // August
  assert.equal(d.getDate(), 15);      // NOT the 14th
  assert.equal(d.getHours(), 17);
});

test('invalid calendar dates are rejected (no silent rollover)', () => {
  assert.equal(parseLooseDate('2026-02-31').ok, false);
  assert.equal(parseLooseDate('2026-13-01').ok, false);
});

test('full ISO date-times round-trip exactly', () => {
  const iso = '2026-08-15T09:30:00.000Z';
  const r = parseLooseDate(iso);
  assert.equal(r.ok, true);
  assert.equal(r.iso, iso);
});

test('ISO without timezone is interpreted as local time', () => {
  const r = parseLooseDate('2026-08-15T09:30:00');
  assert.equal(r.ok, true);
  const d = new Date(r.iso);
  assert.equal(d.getDate(), 15);
  assert.equal(d.getHours(), 9);
});

test('natural language without a time defaults to 17:00 local', () => {
  const r = parseLooseDate('tomorrow', { reference: REF });
  assert.equal(r.ok, true);
  const d = new Date(r.iso);
  assert.equal(d.getDate(), 11);
  assert.equal(d.getHours(), 17);
});

test('natural language with a time keeps the time', () => {
  const r = parseLooseDate('tomorrow at 9am', { reference: REF });
  assert.equal(r.ok, true);
  const d = new Date(r.iso);
  assert.equal(d.getDate(), 11);
  assert.equal(d.getHours(), 9);
});

test('weekday names resolve forward, never into the past', () => {
  // REF is a Wednesday; "monday" must be the NEXT Monday (June 15), not June 8.
  const r = parseLooseDate('monday', { reference: REF });
  assert.equal(r.ok, true);
  const d = new Date(r.iso);
  assert.ok(d > REF, `expected ${r.iso} to be after the reference`);
  assert.equal(d.getDay(), 1);
});

test('garbage input fails loudly with the raw echoed back', () => {
  const r = parseLooseDate('blorpfest');
  assert.equal(r.ok, false);
  assert.equal(r.raw, 'blorpfest');
  assert.ok(r.error.includes('blorpfest'));
});
