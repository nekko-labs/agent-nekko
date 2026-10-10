import React from 'react';
import { createRoot } from 'react-dom/client';
import { ActivityGroup } from '../src/renderer/components/agent-console/ActivityGroup';
import { ToolCard } from '../src/renderer/components/agent-console/ToolCard';
import { ReplyStatus } from '../src/renderer/components/agent-console/ReplyStatus';
import '../src/renderer/styles.css';

const calls = [
  { id: 'ok', name: 'spawn_agent', input: { title: 'Integration checks', task: 'Run the integration checks and summarize the outcomes for each platform.' } },
  { id: 'failed', name: 'spawn_agent', input: { title: 'Platform check', task: 'Check the unavailable platform and report any blockers.' } },
  { id: 'pending', name: 'spawn_agent', input: { title: 'Evidence review', task: 'Inspect the remaining evidence and provide a concise summary.' } },
];
const items: any[] = [
  { kind: 'reasoning', text: 'Delegate focused work to independent checks.', duration: 2 },
  { kind: 'tool', call: calls[0], result: { toolCallId: 'ok', output: 'All integration checks passed.\n\n- Desktop: passed\n- Mobile: passed' } },
  { kind: 'tool', call: calls[1], result: { toolCallId: 'failed', output: 'Platform unavailable in this synthetic fixture.', isError: true } },
  { kind: 'tool', call: calls[2] },
];
function Fixture() {
  return <div className="fixture-shell"><header>Nekko Agent <span>Component verification · synthetic transcript</span></header><main>
    <p className="fixture-label">Delegation steps</p>
    <ActivityGroup items={items} />
    <p className="fixture-label">Standalone tool call</p><ToolCard call={calls[0] as any} />
    <p className="fixture-label">Reply states</p>
    <ReplyStatus streaming={false} status="" elapsed={0} tps={0} out={0} last={{ out: 451, tps: 31, secs: 12 }} nextWakeAt={Date.now() + 300000} />
    <ReplyStatus streaming={false} status="" elapsed={0} tps={0} out={0} last={{ out: 451, tps: 31, secs: 12 }} blocked="Waiting for access" />
  </main></div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
