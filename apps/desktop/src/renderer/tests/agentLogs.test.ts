import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('keeps owning-session logs available without the compact-pane visibility gate', () => {
  const source = readFileSync(new URL('../components/ChatPane.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('aria-label="Open agent logs"');
  expect(start).toBeGreaterThan(0);
  const control = source.slice(source.lastIndexOf('<button', start), source.indexOf('</button>', start));
  expect(control).toContain('openTerminalPane(`agent_${sessionId}`)');
  expect(control).toContain("compact ? <TerminalIcon");
  expect(source.slice(source.lastIndexOf('</button>', start) + 9, start)).not.toContain('!compact');
});
