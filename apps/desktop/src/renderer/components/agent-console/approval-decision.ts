import type { NekkoApi } from '@nekko-agent/shared';

export type ApprovalScope = 'once' | 'session' | 'always';

/** Save the policy before releasing the pending tool, so the next call sees it. */
export async function decideApproval(
  api: Pick<NekkoApi, 'setSessionOptions' | 'updateSettings' | 'approveTool'>,
  sessionId: string,
  callId: string,
  approved: boolean,
  scope: ApprovalScope = 'once',
) {
  const session = approved && scope !== 'once'
    ? await api.setSessionOptions(sessionId, { mode: 'yolo' })
    : null;
  if (approved && scope !== 'once' && !session) throw new Error('Could not update this session’s approval mode.');
  const settings = approved && scope === 'always'
    ? await api.updateSettings({ defaultChatMode: 'yolo' })
    : null;
  await api.approveTool(sessionId, callId, approved);
  return { session, settings };
}
