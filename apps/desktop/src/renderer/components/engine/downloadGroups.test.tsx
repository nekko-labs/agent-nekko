import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DownloadJob } from '@agent-nekko/shared';
import { fileRole, groupDownloads, groupState } from './downloadGroups.js';
import { DownloadsPanel } from './DownloadsPanel.js';

const GB = 1024 ** 3;
const group = 'model:org/Qwen3.8-GGUF:IQ3_S';

function job(over: Partial<DownloadJob>): DownloadJob {
  return { id: 'x', kind: 'model', label: 'x', target: 'org/Qwen3.8-GGUF', state: 'downloading', receivedBytes: 0, startedAt: 1, ...over };
}

// The screenshot that prompted this: weights split in two plus a projector,
// shown as three unrelated rows.
const qwen: DownloadJob[] = [
  job({ id: `${group}:mmproj-Qwen3.8-BF16.gguf`, label: 'Qwen3.8 · mmproj-Qwen3.8-BF16.gguf', group, groupLabel: 'Qwen3.8 · IQ3_S', file: 'mmproj-Qwen3.8-BF16.gguf', state: 'done', receivedBytes: 0.8 * GB, totalBytes: 0.8 * GB, startedAt: 3 }),
  job({ id: group, label: 'Qwen3.8 · IQ3_S', group, groupLabel: 'Qwen3.8 · IQ3_S', file: 'IQ3_S/Qwen3.8-IQ3_S-00001-of-00002.gguf', receivedBytes: 1 * GB, totalBytes: 25 * GB, bytesPerSecond: 5e6, startedAt: 1 }),
  job({ id: `${group}:IQ3_S/Qwen3.8-IQ3_S-00002-of-00002.gguf`, label: 'Qwen3.8 · Qwen3.8-IQ3_S-00002-of-00002.gguf', group, groupLabel: 'Qwen3.8 · IQ3_S', file: 'IQ3_S/Qwen3.8-IQ3_S-00002-of-00002.gguf', receivedBytes: 3 * GB, totalBytes: 26 * GB, bytesPerSecond: 6e6, startedAt: 2 }),
];

describe('download groups', () => {
  it('folds a model and its companion files into one download, weights first', () => {
    const groups = groupDownloads(qwen);
    expect(groups).toHaveLength(1);
    const [g] = groups;
    expect(g.label).toBe('Qwen3.8 · IQ3_S');
    expect(g.jobs.map((j) => j.file)).toEqual([
      'IQ3_S/Qwen3.8-IQ3_S-00001-of-00002.gguf',
      'IQ3_S/Qwen3.8-IQ3_S-00002-of-00002.gguf',
      'mmproj-Qwen3.8-BF16.gguf',
    ]);
    expect(g.state).toBe('downloading');
    expect(g.receivedBytes).toBeCloseTo(4.8 * GB);
    expect(g.totalBytes).toBeCloseTo(51.8 * GB);
    expect(g.bytesPerSecond).toBe(11e6);
  });

  it('keeps ungrouped jobs (engine builds, older hosts) as their own rows', () => {
    const groups = groupDownloads([job({ id: 'engine:b1', kind: 'engine', label: 'llama.cpp b1', startedAt: 5 }), ...qwen]);
    expect(groups.map((g) => g.id)).toEqual(['engine:b1', group]);
    expect(groups[0].jobs).toHaveLength(1);
  });

  it('leaves the total unknown while a file has not reported its size', () => {
    const [g] = groupDownloads([...qwen, job({ id: `${group}:tokenizer.json`, group, file: 'tokenizer.json', state: 'queued' })]);
    expect(g.totalBytes).toBeUndefined();
  });

  it('reports a failure anywhere, otherwise the least finished state', () => {
    expect(groupState(['done', 'failed', 'downloading'])).toBe('failed');
    expect(groupState(['done', 'queued'])).toBe('queued');
    expect(groupState(['done', 'done'])).toBe('done');
    expect(groupState(['done', 'cancelled'])).toBe('cancelled');
  });

  it('names each file for what it is and why it came along', () => {
    expect(fileRole('mmproj-Qwen3.8-BF16.gguf').title).toBe('Vision projector');
    expect(fileRole('mmproj-Qwen3.8-BF16.gguf').purpose).toMatch(/images/);
    expect(fileRole('a/Qwen-IQ3_S-00002-of-00002.gguf').title).toBe('Model weights, part 2 of 2');
    expect(fileRole('Qwen3-4B-Q4_K_M.gguf').title).toBe('Model weights');
    expect(fileRole('tokenizer.json').title).toBe('Tokenizer');
    expect(fileRole('tokenizer_config.json').title).toBe('Tokenizer settings');
    expect(fileRole('chat_template.jinja').title).toBe('Chat template');
    expect(fileRole('config.json').title).toBe('Model config');
    expect(fileRole('ae.safetensors', 'VAE').title).toBe('VAE');
  });
});

describe('downloads panel', () => {
  it('renders one row for the model with a titled subrow per file', () => {
    const html = renderToStaticMarkup(<DownloadsPanel jobs={qwen} onChanged={() => {}} />);
    expect(html.match(/data-download-group=/g)).toHaveLength(1);
    expect(html.match(/data-download-file=/g)).toHaveLength(3);
    expect(html).toContain('3 files');
    expect(html).toContain('Model weights, part 1 of 2');
    expect(html).toContain('Model weights, part 2 of 2');
    expect(html).toContain('Vision projector');
    expect(html).toContain('Lets the model see images');
  });

  it('keeps a single-file download as a plain row without subrows', () => {
    const html = renderToStaticMarkup(<DownloadsPanel jobs={[job({ id: 'model:a:Q4', label: 'A · Q4', group: 'model:a:Q4', file: 'a-Q4.gguf' })]} onChanged={() => {}} />);
    expect(html).not.toContain('data-download-file=');
    expect(html).toContain('A · Q4');
  });
});
