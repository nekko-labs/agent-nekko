import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApprovalBar } from './ApprovalBar.js';

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
  const surface = ApprovalBar({ approval, onDecide: decide });
  const preventDefault = vi.fn();
  surface.props.onKeyDown({ key: 'a', preventDefault });
  expect(decide).not.toHaveBeenCalled();
  surface.props.onKeyDown({ key: 'Y', preventDefault });
  expect(decide).toHaveBeenLastCalledWith(true);
  surface.props.onKeyDown({ key: 'n', preventDefault });
  expect(decide).toHaveBeenLastCalledWith(false);
  surface.props.onKeyDown({ key: 'Escape', preventDefault });
  expect(decide).toHaveBeenLastCalledWith(false);
});
