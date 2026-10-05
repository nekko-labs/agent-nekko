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
it('requires published PR descriptions to keep unfinished work explicit and current', () => {
  const prompt = buildSystemPrompt({ workspaces: [], platform: 'win32', contextBlock: '' });
  expect(prompt).toContain('Unfinished work / release blockers');
  expect(prompt).toContain('Keep this section current after each pushed batch');
  expect(prompt).toContain('Verify the published description');
  expect(prompt).toContain('keep the PR draft/unmerged');
});
it('omits empty customization sections', () => {
  const prompt = buildSystemPrompt({ workspaces: [], platform: 'win32', contextBlock: '', turnWrapper: '' });
  expect(prompt).not.toContain('Server instructions for this user turn:');
  expect(prompt).not.toContain('About the user');
});
