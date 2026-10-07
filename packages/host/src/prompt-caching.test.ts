import { expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promptCachingEnabled, estimateCost } from '@agent-nekko/shared';
import { withDataDir } from './paths.js';
import { getSettings, saveSettings } from './store.js';
import { buildArgs } from './engine/server.js';
import { hostProviderConfig, registerManagedCacheEndpoint } from './prompt-caching.js';

it('migrates omitted settings to on and preserves explicit off', () => {
  for (const value of [undefined, true, false]) {
    const dir = mkdtempSync(join(tmpdir(), 'nekko-cache-'));
    try {
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ promptCaching: value }));
      withDataDir(dir, () => {
        expect(promptCachingEnabled(getSettings())).toBe(value !== false);
        saveSettings({ promptCaching: false });
        expect(promptCachingEnabled(getSettings())).toBe(false);
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
it('only trusts an owned managed endpoint, ignoring persisted assertions', () => {
  const config = { id: 'p', kind: 'llamacpp' as const, label: 'P', baseUrl: 'http://local/v1', enabled: true, managedCachePrompt: true };
  registerManagedCacheEndpoint(() => undefined);
  expect(hostProviderConfig(config).managedCachePrompt).toBeUndefined();
  registerManagedCacheEndpoint(() => config.baseUrl);
  expect(hostProviderConfig(config).managedCachePrompt).toBe(true);
  expect(hostProviderConfig({ ...config, kind: 'openai-compat' }).managedCachePrompt).toBeUndefined();
  expect(hostProviderConfig({ ...config, baseUrl: 'http://remote/v1' }).managedCachePrompt).toBeUndefined();
  registerManagedCacheEndpoint(() => undefined);
});
it('capability-gates RAM reuse flags without disk storage or context loss', () => {
  const model = { id: 'm', path: 'model.gguf' } as never;
  const supported = (flag: string) => ['--cache-reuse', '--cache-ram', '--no-cache-idle-slots'].includes(flag);
  const on = buildArgs(model, 1234, { contextTokens: 8192 }, undefined, supported, true);
  const off = buildArgs(model, 1234, { contextTokens: 8192 }, undefined, supported, false);
  expect(on).toContain('256');
  expect(off).toContain('--cache-ram');
  expect(off[off.indexOf('--cache-reuse') + 1]).toBe('0');
  for (const args of [on, off]) {
    expect(args[args.indexOf('--ctx-size') + 1]).toBe('8192');
    expect(args).not.toContain('--slot-save-path');
    expect(args).not.toContain('--prompt-cache');
  }
  expect(buildArgs(model, 1234, {}, undefined, () => false, false)).not.toContain('--cache-reuse');
});
it('prices cache counts separately with conservative unknown-rate fallback', () => {
  expect(estimateCost('claude-sonnet', { inputTokens: 1e6, outputTokens: 0, cacheReadTokens: 1e6, cacheWriteTokens: 1e6 })).toBe(7.05);
  expect(estimateCost('gpt-4o', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1e6 })).toBe(2.5);
});
