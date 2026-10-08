import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
describe('sandbox renderer safety regressions', () => {
  it('requires pinned local image and explicit setup consent', () => {
    const setup = source('./SandboxSetup.tsx');
    expect(setup).toContain('@sha256:[a-f0-9]{64}$');
    expect(setup).toContain('!consent || !isPinnedSandboxImage(image)');
    expect(setup).toContain("executionMode: 'sandbox', mode: 'ask'");
    expect(setup).toContain('No images will be pulled.');
  });
  it('never offers a working apply-back action', () => {
    const setup = source('./SandboxSetup.tsx');
    expect(setup).toContain('host API is fail-closed');
    expect(setup).not.toContain('applySandboxDiff(');
    expect(setup).toContain('Sandbox diff (read-only)');
  });
  it('keeps execution and permissions separate and persists the default', () => {
    const controls = source('./ChatControls.tsx');
    expect(controls).toContain('grid grid-cols-2');
    expect(controls).toContain('getExecutionMode(session)');
    expect(controls).toContain('defaultExecutionMode: executionMode');
    expect(controls).toContain('(recommended)');
    expect(source('./WorktreeChip.tsx')).toContain('{ gitIsolation, executionMode }');
  });
  it('wires the exact shared sandbox channels in both transports', () => {
    for (const file of ['../../preload/index.ts', '../web-client.ts']) {
      const transport = source(file);
      for (const channel of ['sandboxConfigure', 'sandboxStatus', 'sandboxDiff', 'sandboxApplyDiff']) expect(transport).toContain(`IpcChannels.${channel}`);
    }
  });
  it('blocks host panels before mounting their side effects', () => {
    expect(source('./ContextInspector.tsx')).toContain('HostContextInspector');
    expect(source('./SpecPanel.tsx')).toContain('HostSpecPanel');
    expect(source('./FilePane.tsx')).toContain('HostFilePane');
    expect(source('./ChatPane.tsx')).toContain('Configure Sandbox before executing.');
    expect(source('./Markdown.tsx')).toContain('Host image previews are unavailable in Sandbox');
  });
});
