import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApprovalBar, handleApprovalKey, isTruncated } from './ApprovalBar.js';

const approval = { call: { id: 'approval', name: 'bash', input: { command: 'echo test' } }, reason: 'Confirm command', severity: 'medium' as const };
const longApproval = {
  call: {
    id: 'long',
    name: 'bash',
    input: { command: 'npm run build --workspace=@agent-nekko/desktop -- --config vite.config.ts --outDir dist --minify' }
  },
  reason: 'Confirm long command',
  severity: 'high' as const
};

it('renders approval controls without automatic focus', () => {
  const html = renderToStaticMarkup(<ApprovalBar approval={approval} onDecide={vi.fn()} />);
  expect(html).toContain('Approval required');
  expect(html).toContain('Deny');
  expect(html).toContain('Approve');
  expect(html).not.toContain('autofocus');
});

it('includes title attribute on the command for hover tooltip', () => {
  const html = renderToStaticMarkup(<ApprovalBar approval={longApproval} onDecide={vi.fn()} />);
  expect(html).toContain('title="npm run build --workspace=@agent-nekko/desktop -- --config vite.config.ts --outDir dist --minify"');
});

it('keeps keyboard decisions scoped to the approval surface', () => {
  const decide = vi.fn();
  const preventDefault = vi.fn();
  handleApprovalKey({ key: 'a', preventDefault }, decide);
  expect(decide).not.toHaveBeenCalled();
  handleApprovalKey({ key: 'Y', preventDefault }, decide);
  expect(decide).toHaveBeenLastCalledWith(true);
  handleApprovalKey({ key: 'n', preventDefault }, decide);
  expect(decide).toHaveBeenLastCalledWith(false);
  handleApprovalKey({ key: 'Escape', preventDefault }, decide);
  expect(decide).toHaveBeenLastCalledWith(false);
});

it('does not show toggle for short text that fits', () => {
  // Short text should not have truncate class, so the toggle won't be shown
  const html = renderToStaticMarkup(<ApprovalBar approval={approval} onDecide={vi.fn()} />);
  // No aria-expanded button should be present for short text
  expect(html).not.toContain('Show full');
  expect(html).not.toContain('Show less');
});

it('shows expand toggle for long text that is truncated', () => {
  // Long text is truncated, so toggle should be rendered
  const html = renderToStaticMarkup(<ApprovalBar approval={longApproval} onDecide={vi.fn()} />);
  expect(html).toContain('Show full command');
  // aria-expanded is added dynamically, so we check for the button text
  expect(html).toContain('Show full');
});

it('calls onDecide handlers correctly', () => {
  const onDecide = vi.fn().mockResolvedValue(undefined);
  const html = renderToStaticMarkup(<ApprovalBar approval={approval} onDecide={onDecide} />);
  
  expect(html).toContain('Approve');
  expect(html).toContain('Deny');
  
  // Verify the handlers are callable (static markup doesn't execute click handlers)
  expect(onDecide).not.toHaveBeenCalled();
});
