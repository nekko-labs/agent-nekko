import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./terminal.js', () => ({ appendAgentTerminal: vi.fn(() => 'agent_s') }));

const { appendAgentTerminal } = await import('./terminal.js');
const { PROCESS_LIMIT, describeProcess, killProcess, killSessionProcesses, listProcesses, readProcess, startProcess } = await import('./processes.js');

/** A command that prints a line, waits, prints another, and exits 0. */
const slow = `node -e "console.log('one'); setTimeout(() => { console.log('two'); }, 300)"`;
/** A command that runs until killed. */
const forever = `node -e "setInterval(() => console.log('tick'), 100)"`;

const cwd = process.cwd();

afterEach(() => {
  for (const s of ['s1', 's2', 's3']) killSessionProcesses(s);
});

describe('background processes', () => {
  it('starts a command, hands back its output as it arrives, and forgets it once read after exit', async () => {
    const info = startProcess({ sessionId: 's1', command: slow, cwd, name: 'slow' });
    expect(info.id).toMatch(/^p_/);
    expect(info.pid).toBeGreaterThan(0);
    expect(listProcesses('s1').map((p) => p.id)).toEqual([info.id]);
    expect(describeProcess(info)).toMatch(/\(slow\): running/);

    const first = await readProcess(info.id, { waitMs: 5_000 });
    expect(first!.output).toContain('one');

    // Wait for the rest and the exit.
    let last = first!;
    for (let i = 0; i < 20 && last.info.exitCode === undefined; i++) {
      last = (await readProcess(info.id, { waitMs: 2_000 }))!;
    }
    expect(last.info.exitCode).toBe(0);
    // Drained after exit: the id is gone.
    expect(await readProcess(info.id)).toBeUndefined();
    expect(listProcesses('s1')).toEqual([]);
    // Everything went to the agent terminal too.
    const mirrored = (appendAgentTerminal as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => c[2]).join('');
    expect(mirrored).toContain('[slow, background]');
    expect(mirrored).toContain('two');
    expect(mirrored).toMatch(/exited with code 0/);
  });

  it('keeps everything with `all`, and reads only what is new otherwise', async () => {
    const info = startProcess({ sessionId: 's1', command: slow, cwd });
    const a = await readProcess(info.id, { waitMs: 5_000 });
    expect(a!.output).toContain('one');
    const b = await readProcess(info.id);
    expect(b!.output).not.toContain('one');
    let c = await readProcess(info.id, { waitMs: 2_000, all: true });
    for (let i = 0; i < 20 && !c!.output.includes('two'); i++) c = await readProcess(info.id, { waitMs: 1_000, all: true });
    expect(c!.output).toContain('one');
    expect(c!.output).toContain('two');
  });

  it('kills a process that would run for ever, and every process of a chat on Stop', async () => {
    const a = startProcess({ sessionId: 's2', command: forever, cwd, name: 'a' });
    const b = startProcess({ sessionId: 's2', command: forever, cwd, name: 'b' });
    const other = startProcess({ sessionId: 's1', command: forever, cwd, name: 'other' });
    expect((await readProcess(a.id, { waitMs: 5_000 }))!.output).toContain('tick');

    expect(killProcess(a.id)).toBe(true);
    let read = await readProcess(a.id, { waitMs: 5_000 });
    for (let i = 0; i < 20 && read && read.info.exitCode === undefined; i++) read = await readProcess(a.id, { waitMs: 1_000 });
    expect(read?.info.exitCode === undefined).toBe(false);

    expect(killSessionProcesses('s2')).toBe(1);
    let bRead = await readProcess(b.id, { waitMs: 5_000 });
    for (let i = 0; i < 20 && bRead && bRead.info.exitCode === undefined; i++) bRead = await readProcess(b.id, { waitMs: 1_000 });
    expect(bRead?.info.exitCode === undefined).toBe(false);
    // The other chat's process is untouched.
    expect(listProcesses('s1').find((p) => p.id === other.id)?.exitCode).toBeUndefined();
    expect(killProcess('p_nope')).toBe(false);
  });

  it('caps how many a chat may run at once', () => {
    const ids: string[] = [];
    for (let i = 0; i < PROCESS_LIMIT; i++) ids.push(startProcess({ sessionId: 's3', command: forever, cwd }).id);
    expect(() => startProcess({ sessionId: 's3', command: forever, cwd })).toThrow(/already has/);
    expect(listProcesses('s3')).toHaveLength(PROCESS_LIMIT);
  });
});
