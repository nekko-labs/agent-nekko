import React from 'react';
import { createRoot } from 'react-dom/client';
import { DownloadsPanel } from '../src/renderer/components/engine/DownloadsPanel';

// Synthetic jobs mirroring a split vision model mid-download: two weight shards
// and a projector that already landed. The base revision ignores the group fields.
const GB = 1024 ** 3;
const MB = 1024 ** 2;
const group = 'model:org/Qwen3.8-Flash-Next-GSQ-RCO-GGUF:IQ3_S';
const groupLabel = 'Qwen3.8 Flash Next GSQ RCO · IQ3_S';
const now = Date.now();
const jobs: any[] = [
  { id: `${group}:mmproj-Qwen3.8-Flash-Next-BF16.gguf`, kind: 'model', label: 'Qwen3.8 Flash Next GSQ RCO · mmproj-Qwen3.8-Flash-Next-BF16.gguf', target: 'org/x', group, groupLabel, file: 'mmproj-Qwen3.8-Flash-Next-BF16.gguf', state: 'done', receivedBytes: 866 * MB, totalBytes: 866 * MB, startedAt: now - 1000 },
  { id: group, kind: 'model', label: groupLabel, target: 'org/x', group, groupLabel, file: 'IQ3_S/Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S-00001-of-00002.gguf', state: 'downloading', receivedBytes: 707 * MB, totalBytes: 24.3 * GB, bytesPerSecond: 4 * MB, startedAt: now - 3000 },
  { id: `${group}:IQ3_S/Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S-00002-of-00002.gguf`, kind: 'model', label: 'Qwen3.8 Flash Next GSQ RCO · Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S-00002-of-00002.gguf', target: 'org/x', group, groupLabel, file: 'IQ3_S/Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S-00002-of-00002.gguf', state: 'downloading', receivedBytes: 3.6 * GB, totalBytes: 26.8 * GB, bytesPerSecond: 11 * MB, startedAt: now - 2000 },
  { id: 'model:org/Qwen3-4B-GGUF:Q4_K_M', kind: 'model', label: 'Qwen3 4B · Q4_K_M', target: 'org/Qwen3-4B-GGUF', group: 'model:org/Qwen3-4B-GGUF:Q4_K_M', groupLabel: 'Qwen3 4B · Q4_K_M', file: 'Qwen3-4B-Q4_K_M.gguf', state: 'done', receivedBytes: 2.3 * GB, totalBytes: 2.3 * GB, startedAt: now - 60000 },
];

function Fixture() {
  return (
    <div className="fixture-shell">
      <main>
        <div className="card p-4 sm:p-5">
          <DownloadsPanel jobs={jobs} onChanged={() => {}} />
        </div>
      </main>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
