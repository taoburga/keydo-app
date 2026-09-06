import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReportExport } from '../lib/report-export.js';

test('exports only open reports in stable filename order', () => {
  const out = buildReportExport([
    { name: 'report-b.md', markdown: '---\nstatus: open\n---\n\n# Bug: second' },
    { name: 'README.md', markdown: 'status: open' },
    { name: 'report-fixed.md', markdown: '---\nstatus: fixed\n---\n\n# Bug: old' },
    { name: 'report-a.md', markdown: '---\nstatus: open\n---\n\n# Feature request: first' },
  ], { generatedAt: '2026-07-26T12:00:00.000Z' });

  assert.equal(out.count, 2);
  assert.match(out.markdown, /Open reports: 2/);
  assert.ok(out.markdown.indexOf('Feature request: first') < out.markdown.indexOf('Bug: second'));
  assert.doesNotMatch(out.markdown, /Bug: old/);
});

test('returns an empty packet when there are no open reports', () => {
  assert.deepEqual(buildReportExport([
    { name: 'report-fixed.md', markdown: '---\nstatus: fixed\n---' },
  ]), { count: 0, markdown: '' });
});

test('status is read only from frontmatter, not tester-written text', () => {
  const out = buildReportExport([
    {
      name: 'report-fixed.md',
      markdown: '---\nstatus: fixed\n---\n\n# Bug: old\n\nThe screen said status: open',
    },
  ]);
  assert.deepEqual(out, { count: 0, markdown: '' });
});
