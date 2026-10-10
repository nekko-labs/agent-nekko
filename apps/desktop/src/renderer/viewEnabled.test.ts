import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@agent-nekko/shared';

vi.hoisted(() => {
  Object.assign(globalThis, { window: { innerWidth: 1280, addEventListener() {} }, localStorage: { getItem: () => null } });
});
const { useStore, viewEnabled } = await import('./store.js');
const { LANGUAGES, translate } = await import('./i18n.js');
const settings = (developer: AppSettings['developer']) => ({ developer }) as AppSettings;

describe('navigation visibility', () => {
  it('keeps Agents available while Chat is default-off, including before settings load', () => {
    for (const value of [null, undefined, settings(undefined), settings({ serverControls: true }), settings({ chat: false })]) {
      expect(viewEnabled('command', value)).toBe(true);
      expect(viewEnabled('chat', value)).toBe(false);
    }
    expect(viewEnabled('chat', settings({ chat: true }))).toBe(true);
  });

  it('redirects attempts to open disabled Chat to Agents', () => {
    useStore.setState({ settings: settings({ chat: false }), view: 'settings' });
    useStore.getState().setView('chat');
    expect(useStore.getState().view).toBe('command');
    useStore.setState({ settings: settings({ chat: true }) });
    useStore.getState().setView('chat');
    expect(useStore.getState().view).toBe('chat');
  });

  it('preserves the existing experimental-view conventions', () => {
    for (const view of ['training', 'design', 'memory'] as const) {
      expect(viewEnabled(view, settings({ chat: true }))).toBe(false);
      expect(viewEnabled(view, { ...settings(undefined), experimental: { [view]: true } })).toBe(true);
    }
  });

  it('renames both destinations in every shipped locale', () => {
    expect(translate('en', 'nav.command')).toBe('Agents');
    expect(translate('en', 'nav.chat')).toBe('Chat');
    for (const { code } of LANGUAGES) {
      expect(translate(code, 'nav.command')).not.toBe('nav.command');
      expect(translate(code, 'nav.chat')).not.toBe('nav.chat');
      expect(translate(code, 'nav.command')).not.toBe(translate(code, 'nav.chat'));
    }
  });

  it('uses the still cat for Agents and filters both rails with viewEnabled', () => {
    const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('<NekkoAvatar size={22} stationary eyes={false} />');
    expect(app).toContain("{ view: 'command', labelKey: 'nav.command', Icon: AgentCatIcon }");
    expect(app).toContain('filter(n => viewEnabled(n.view, settings))');
    expect(app).toContain('MOBILE_NAV.filter((v) => viewEnabled(v, settings))');
    expect(app).toContain("if (!viewEnabled(view, settings)) setView('command')");
  });
});
