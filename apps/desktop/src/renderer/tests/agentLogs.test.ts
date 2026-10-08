import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const source = readFileSync(new URL('../components/ChatPane.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const bubble = readFileSync(new URL('../components/AgentLogsBubble.tsx', import.meta.url), 'utf8');

it('keeps owning-session logs available without the compact-pane visibility gate', () => {
  const start = source.indexOf('aria-label="Open agent logs"');
  expect(start).toBeGreaterThan(0);
  const control = source.slice(source.lastIndexOf('<button', start), source.indexOf('</button>', start));
  expect(control).toContain('openTerminalPane(`agent_${sessionId}`)');
  expect(control).toContain("compact ? <TerminalIcon");
  expect(source.slice(source.lastIndexOf('</button>', start) + 9, start)).not.toContain('!compact');
});

it('opens the log in a bubble on the Agents wall instead of the hidden Chat view', () => {
  const start = source.indexOf('aria-label="Open agent logs"');
  const control = source.slice(source.lastIndexOf('<button', start), source.indexOf('</button>', start));
  // The wall toggles the in-window bubble; only the Chat view's workbench opens a pane.
  expect(control).toContain('commandCenter ? setLogsOpen((o) => !o) : useStore.getState().openTerminalPane(`agent_${sessionId}`)');
  expect(source).toContain('<AgentLogsBubble');
  expect(bubble).toContain('<TerminalPane terminalId={`agent_${sessionId}`} />');
  // Popping out to a pane is offered only when the Chat view exists.
  expect(source).toContain('onPopOut={chatViewOn ?');
});

it('bubbles out from the middle of the window\u2019s right edge', () => {
  expect(css).toMatch(/\.agent-logs-bubble \{\s*position: absolute; right: 12px; top: 50%;/);
  expect(css).toContain('transform: translateY(-50%); transform-origin: 100% 50%;');
  expect(css).toContain('@keyframes agent-logs-bubble-in');
  expect(css).toContain('@media (prefers-reduced-motion: reduce) { .agent-logs-bubble { animation: none; } }');
});
