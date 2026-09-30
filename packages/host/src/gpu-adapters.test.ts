import { describe, expect, it } from 'vitest';
import { buildsFor, recommendedBuild } from './engine/builds.js';
import { parseWindowsAdapters } from './gpu-adapters.js';

describe('GPU adapters from the OS', () => {
  it('reads vendor ids from Windows video controllers and skips virtual adapters', () => {
    const text = [
      String.raw`AMD Radeon RX 7900 XTX|PCI\VEN_1002&DEV_744C&SUBSYS_0E3A1002`,
      String.raw`Intel(R) Arc(TM) A770 Graphics|PCI\VEN_8086&DEV_56A0`,
      String.raw`Microsoft Basic Display Adapter|ROOT\BASICDISPLAY\0000`,
      String.raw`Parsec Virtual Display Adapter|ROOT\DISPLAY\0000`,
      '',
    ].join('\r\n');
    expect(parseWindowsAdapters(text)).toEqual([
      { vendor: 'amd', name: 'AMD Radeon RX 7900 XTX' },
      { vendor: 'intel', name: 'Intel(R) Arc(TM) A770 Graphics' },
    ]);
  });

  it('offers Vulkan, not CPU, to an AMD PC with no NVIDIA reading', () => {
    const amd = [{ vendor: 'amd' as const, name: 'AMD Radeon RX 7900 XTX' }];
    expect(recommendedBuild('win32', 'x64', null, amd)?.backend).toBe('vulkan');
    expect(recommendedBuild('linux', 'x64', null, [{ vendor: 'intel', name: 'card0' }])?.backend).toBe('vulkan');
  });

  it('still leads with CPU when the OS reports no GPU at all', () => {
    expect(recommendedBuild('win32', 'x64', null, [])?.backend).toBe('cpu');
    expect(buildsFor('win32', 'x64', null, [{ vendor: 'other', name: 'Some adapter' }])[0]?.backend).toBe('cpu');
  });
});
