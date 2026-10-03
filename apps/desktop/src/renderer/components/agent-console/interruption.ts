export function describeInterruption(message: string, canContinue: boolean) {
  const paused = message === 'Stopped';
  const detail = paused
    ? 'You stopped this reply.'
    : /^terminated\.?$/i.test(message.trim())
      ? 'The response stream ended unexpectedly. The provider did not report a specific cause.'
      : message;
  return {
    paused,
    reason: detail,
    title: paused ? 'Reply paused' : 'Reply failed',
    detail: `${detail} ${canContinue ? 'The work so far is saved; Continue picks up from here.' : 'No resumable progress was saved. You can start over.'}`,
  };
}

export const suggestedReplyClassName = 'max-w-full truncate rounded-full border border-accent/25 bg-accent/10 px-3 py-1.5 text-left text-[12px] font-medium text-ink-soft hover:border-accent/50 hover:bg-accent/20 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';
