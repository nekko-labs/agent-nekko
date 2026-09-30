import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const daemon = vi.fn();
let linked = false;
vi.mock('./engine/daemon.js', () => ({ daemonCall: () => (linked ? daemon : undefined) }));

const { acceptAllChanges, acceptChange, listChanges, notifyChanges, recordOriginal, setChangeNotifier } = await import('./changes.js');

describe('pending changes', () => {
  beforeEach(() => {
    daemon.mockReset();
    linked = false;
  });

  it('keeps the list here without a daemon', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nekko-changes-'));
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'before');
    await recordOriginal('s1', file);
    writeFileSync(file, 'after');
    expect(await listChanges('s1')).toEqual([{ path: file, original: 'before', current: 'after' }]);
    await acceptChange('s1', file);
    expect(await listChanges('s1')).toEqual([]);
    expect(daemon).not.toHaveBeenCalled();
  });

  it('uses the daemon list once the daemon keeps it, and relays its notices', async () => {
    linked = true;
    daemon.mockImplementation(async (channel: string) => {
      if (channel === 'daemon:info') return { owned: ['changes:record', 'changes:list', 'changes:accept', 'changes:acceptAll'] };
      if (channel === 'changes:list') return [{ path: '/w/a.ts', original: '', current: 'x' }];
      return null;
    });
    await recordOriginal('s2', '/w/a.ts');
    expect(await listChanges('s2')).toEqual([{ path: '/w/a.ts', original: '', current: 'x' }]);
    await acceptChange('s2', '/w/a.ts');
    await acceptAllChanges('s2');
    expect(daemon.mock.calls.filter((c) => c[0] !== 'daemon:info')).toEqual([
      ['changes:record', 's2', '/w/a.ts'],
      ['changes:list', 's2'],
      ['changes:accept', 's2', '/w/a.ts'],
      ['changes:acceptAll', 's2'],
    ]);
    const heard: string[] = [];
    setChangeNotifier((id) => heard.push(id));
    notifyChanges('s2');
    expect(heard).toEqual(['s2']);
  });
});
