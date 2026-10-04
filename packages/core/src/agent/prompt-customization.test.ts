import { expect, it } from 'vitest';
import { buildSystemPrompt } from './prompt.js';

it('includes server customization separately from user content and built-in policies', () => {
  const prompt = buildSystemPrompt({ workspaces: [], platform: 'win32', contextBlock: '', systemInstructions: 'Prefer short replies.', aboutUser: 'I am learning Rust.', turnWrapper: 'Verify results.', checkoutNotice: 'Committed HEAD; local edits are not included.' });
  expect(prompt).toContain('Custom system instructions:\nPrefer short replies.');
  expect(prompt).toContain('About the user');
  expect(prompt).toContain('I am learning Rust.');
  expect(prompt).toContain('Server instructions for this user turn:\nVerify results.');
  expect(prompt).toContain('Checkout baseline:\nCommitted HEAD; local edits are not included.');
  expect(prompt).not.toContain('Before starting work');
  expect(prompt).toContain('Operating principles:');
});
it('always includes safe app verification guidance without optional capabilities', () => {
  const prompt = buildSystemPrompt({ workspaces: [], platform: 'win32', contextBlock: '' });
  expect(prompt).toContain('App verification:');
  expect(prompt).toContain('Do not launch the app when those checks suffice.');
  expect(prompt).toContain('check for existing instances');
  expect(prompt).toContain('Prefer reusing a matching agent-owned sandbox');
  expect(prompt).toContain("Treat the user's running app as read-only by default; ask before interactions");
  expect(prompt).toContain('separate app data and external side effects disabled by default');
  expect(prompt).toContain("never close the user's app.");
  expect(prompt).toContain('Headless checks do not replace actual desktop-window evidence');
});

it('omits empty customization sections', () => {
  const prompt = buildSystemPrompt({ workspaces: [], platform: 'win32', contextBlock: '', turnWrapper: '' });
  expect(prompt).not.toContain('Server instructions for this user turn:');
  expect(prompt).not.toContain('About the user');
});
