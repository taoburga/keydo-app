const REPORT_EXPORT_MAX = 100;
const REPORT_EXPORT_MAX_CHARS = 2_000_000;

function isOpenReport(markdown) {
  const frontmatter = String(markdown || '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return !!frontmatter && /^status:\s*open\s*$/mi.test(frontmatter[1]);
}

// Build one paste-ready Markdown packet from locally filed, still-open reports.
// Entries are already read from the fixed reports/ directory by server.js; this
// helper only validates, sorts, caps, and formats them.
export function buildReportExport(entries, { generatedAt = new Date().toISOString() } = {}) {
  const open = (Array.isArray(entries) ? entries : [])
    .filter(e => e && /^report-[\w.-]+\.md$/.test(e.name || ''))
    .filter(e => isOpenReport(e.markdown))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .slice(0, REPORT_EXPORT_MAX);

  const included = [];
  let chars = 0;
  for (const entry of open) {
    const markdown = String(entry.markdown || '').trim();
    if (!markdown) continue;
    if (chars + markdown.length > REPORT_EXPORT_MAX_CHARS) break;
    included.push(markdown);
    chars += markdown.length;
  }

  if (!included.length) return { count: 0, markdown: '' };
  const header = [
    '# Todo App feedback export',
    '',
    `Generated: ${generatedAt}`,
    `Open reports: ${included.length}`,
    '',
    'This packet was exported locally by the tester. The tester-written description',
    'is included verbatim. Automatically attached diagnostics contain counts and',
    'settings only — never task names, notes, URLs, or list names.',
    '',
  ].join('\n');
  return {
    count: included.length,
    markdown: header + included.map((report, i) =>
      `---\n\n## Report ${i + 1} of ${included.length}\n\n${report}\n`
    ).join('\n'),
  };
}
