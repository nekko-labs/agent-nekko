import { useState } from 'react';
import type { EngineMemory, LocalModel } from '@agent-nekko/shared';
import { ModelLibrary } from './ModelLibrary.js';
import { CatalogBrowser } from './CatalogBrowser.js';

/**
 * Models, one surface.
 *
 * Installed and downloadable were two tabs once, which made the honest answer
 * to "do I have qwen" depend on which tab you happened to be on. One search box
 * now covers both questions: it filters what is on this machine and searches
 * Hugging Face, so a model you already have and a model you could get sit one
 * after another in the same scroll.
 *
 * Two sections rather than an interleaved list, because the verbs differ —
 * "load" belongs to what is here, "download" to what is not — but they share
 * the query, the empty states, and the size/fit vocabulary.
 */
export function ModelsHome({
  providerId,
  models,
  canLoad,
  memory,
  onChanged,
  onOpenModel,
}: {
  providerId: string;
  models: Array<LocalModel & { loaded: boolean }>;
  canLoad: boolean;
  memory?: EngineMemory;
  onChanged: () => void;
  onOpenModel: (id: string) => void;
}) {
  const [query, setQuery] = useState('');

  return (
    <div>
      <input
        className="input w-full text-[12.5px]"
        placeholder="Search your models and Hugging Face, e.g. qwen coder"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        spellCheck={false}
      />
      <p className="mt-1.5 text-[11px] text-ink-faint">
        <strong>B</strong> is billions of parameters: a bigger model knows more and runs slower and heavier. Sizes are
        the download on disk; "fits here" checks it against this machine's memory.
      </p>

      <h3 className="mt-4 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">On this machine</h3>
      <div className="mt-1.5">
        <ModelLibrary providerId={providerId} models={models} canLoad={canLoad} onChanged={onChanged} query={query} />
      </div>

      <h3 className="mt-4 border-t pt-3 text-[11px] font-semibold uppercase tracking-wide text-ink-faint" style={{ borderColor: 'var(--line)' }}>
        Get more models
      </h3>
      <div className="mt-1.5">
        <CatalogBrowser onOpen={onOpenModel} query={query} onQuery={setQuery} hideSearch memory={memory} />
      </div>
    </div>
  );
}
