import { describe, it, expect } from 'vitest';
import { classifyAgent, detectSkill, agentSignals, classifySession } from '@agent-nekko/shared';
import type { Session, AutomationTask } from '@agent-nekko/shared';

describe('detectSkill', () => {
  it('reads a leading /command', () => {
    expect(detectSkill('/review the diff')).toBe('review');
    expect(detectSkill('  /security-review now')).toBe('security-review');
  });
  it('reads a "skill: name" hint', () => {
    expect(detectSkill('run this. skill: research')).toBe('research');
  });
  it('returns undefined when there is no skill', () => {
    expect(detectSkill('just chatting')).toBeUndefined();
    expect(detectSkill(undefined)).toBeUndefined();
  });
});

describe('classifyAgent', () => {
  it('flags a recurring watch task as a production monitor', () => {
    const t = classifyAgent({ taskKind: 'recurring', prompt: 'monitor the production deploy health every 5 min' });
    expect(t.role).toBe('monitor');
    expect(t.label).toBe('Production monitor');
  });
  it('flags a non-prod recurring watcher as a monitor bot', () => {
    const t = classifyAgent({ taskKind: 'background', taskCondition: 'watch the CI queue for failures' });
    expect(t.role).toBe('monitor');
    expect(t.label).toBe('Monitor bot');
  });
  it('does NOT call a one-off "check this" chat a monitor', () => {
    // No task kind → not standing work, even if it says "check".
    expect(classifyAgent({ prompt: 'check this file for me' }).role).not.toBe('monitor');
  });
  it('classifies review skills and review language', () => {
    expect(classifyAgent({ skill: 'review' }).role).toBe('reviewer');
    expect(classifyAgent({ skill: 'security-review' }).role).toBe('reviewer');
    expect(classifyAgent({ prompt: 'audit the changes for vulnerabilities' }).role).toBe('reviewer');
  });
  it('classifies research and build work', () => {
    expect(classifyAgent({ skill: 'research' }).role).toBe('researcher');
    expect(classifyAgent({ prompt: 'investigate why the build is slow' }).role).toBe('researcher');
    expect(classifyAgent({ skill: 'fix' }).role).toBe('builder');
    expect(classifyAgent({ prompt: 'implement the new export feature' }).role).toBe('builder');
  });
  it('falls back to automation for an unlabelled task, assistant otherwise', () => {
    expect(classifyAgent({ taskKind: 'scheduled', prompt: 'send the digest' }).role).toBe('automation');
    expect(classifyAgent({ prompt: 'hey there' }).role).toBe('assistant');
  });
});

describe('agentSignals / classifySession', () => {
  const base: Session = {
    id: 's1', title: 'New chat', messages: [], createdAt: 0, updatedAt: 0,
  };
  it('pulls the skill and prompt from the first user message', () => {
    const s: Session = { ...base, messages: [{ id: 'm', role: 'user', content: '/review the PR', createdAt: 0 }] };
    const sig = agentSignals(s);
    expect(sig.skill).toBe('review');
    expect(classifySession(s).role).toBe('reviewer');
  });
  it('prefers the driving task prompt/kind when present', () => {
    const task: AutomationTask = {
      id: 't', title: 'Prod watch', kind: 'recurring', prompt: 'monitor production uptime',
      status: 'active', createdAt: 0, runCount: 0,
    };
    expect(classifySession(base, task).role).toBe('monitor');
  });
});
