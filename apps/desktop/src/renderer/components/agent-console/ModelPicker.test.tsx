import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { Object.assign(globalThis, { window: {}, localStorage: { getItem: () => null } }); });
vi.mock('../../store.js', async (original) => {
  const actual = await original<typeof import('../../store.js')>();
  return { ...actual, useStore: Object.assign((selector: (s: ReturnType<typeof actual.useStore.getState>) => unknown) => selector(actual.useStore.getState()), actual.useStore) };
});
import { useStore } from '../../store.js';
import { ModelPicker } from './ModelPicker.js';

describe('default model in the picker', () => {
  it('pins a missing default as disabled above other models', () => {
    const prev = useStore.getState().settings;
    useStore.setState({ settings: { ...prev, defaultProviderId: 'p', defaultModelId: 'missing' } as NonNullable<typeof prev> });
    try {
      const out = renderToStaticMarkup(<ModelPicker expanded open providers={[{id:'p',kind:'openai',label:'Provider',enabled:true,baseUrl:'http://localhost'}]} providerId="p" modelId="other" models={[{id:'other',providerId:'p',name:'Other model'}]} onOpenChange={() => {}} onProvider={() => {}} onModel={() => {}} />);
      expect(out).toContain('Default · unavailable');
      expect(out).toContain('disabled="" aria-disabled="true"');
      expect(out.indexOf('missing')).toBeLessThan(out.indexOf('Other model'));
    } finally { useStore.setState({settings:prev}); }
  });
  it('identifies an available default without duplicating its row', () => {
    const prev = useStore.getState().settings;
    useStore.setState({ settings: { ...prev, defaultProviderId: 'p', defaultModelId: 'other' } as NonNullable<typeof prev> });
    try {
      const out = renderToStaticMarkup(<ModelPicker expanded open providers={[{id:'p',kind:'openai',label:'Provider',enabled:true,baseUrl:'http://localhost'}]} providerId="p" modelId="other" models={[{id:'other',providerId:'p',name:'Other model'}]} onOpenChange={() => {}} onProvider={() => {}} onModel={() => {}} recent={['p::other']} />);
      expect(out).toContain('>Default<');
      expect(out.match(/role="option"/g)).toHaveLength(1);
    } finally { useStore.setState({settings:prev}); }
  });
});
