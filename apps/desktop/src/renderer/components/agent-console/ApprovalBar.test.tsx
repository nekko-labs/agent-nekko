import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApprovalBar, handleApprovalKey } from './ApprovalBar.js';

const approval = { call: { id: 'approval', name: 'bash', input: { command: 'echo test' } }, reason: 'Confirm command', severity: 'medium' as const };

it('renders approval controls without automatic focus', () => {
  const html = renderToStaticMarkup(<ApprovalBar approval={approval} onDecide={vi.fn()} />);
  expect(html).toContain('Approval required');
  expect(html).toContain('Deny');
  expect(html).toContain('Approve');
  expect(html).not.toContain('autofocus');
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
