import { useState } from 'react';
import type { EngineMemory, EngineSettings, LocalModel, ResidentModel } from '@agent-nekko/shared';
import { ModelLibrary } from './ModelLibrary.js';
import { CatalogBrowser } from './CatalogBrowser.js';
import { ResidentModels } from './ResidentModels.js';

/**
 * Models, one surface.
 *
 * Installed and downloadable were two tabs once, which made the honest answer
 * to "do I have qwen" depend on which tab you happened to be on. One search box
 * now covers both questions: it filters what is on this machine and searches
 * Hugging Face, so a model you already have and a model you could get sit one
 * after another in the same scroll.
 *
 * Three sections rather than an interleaved list, because the verbs differ:
 * "unload" belongs to what is in memory, "load" to what is on disk, and
 * "download" to what is not — but they share the query, the empty states, and
 * the size/fit vocabulary.
 */
export function ModelsHome({
  providerId,
  models,
  canLoad,
  memory,
  resident,
  settings,
  running,
  onChanged,
  onOpenModel,
  mlx = false,
}: {
  providerId: string;
  models: Array<LocalModel & { loaded: boolean }>;
  canLoad: boolean;
  memory?: EngineMemory;
  /** The models actually in memory right now, for the "In memory" block. */
  resident: ResidentModel[];
  settings: EngineSettings;
  running: boolean;
  onChanged: () => void;
  onOpenModel: (id: string) => void;
  /** An Apple Silicon Mac, where the catalog also offers MLX checkpoints. */
  mlx?: boolean;
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

      <div className="mt-3">
        <ResidentModels
          providerId={providerId}
          resident={resident}
          models={models}
          settings={settings}
          onChanged={onChanged}
        />
      </div>

      <h3 className="mt-4 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">On this machine</h3>
      <div className="mt-1.5">
        <ModelLibrary
          providerId={providerId}
          models={models}
          canLoad={canLoad}
          onChanged={onChanged}
          query={query}
          autoloadIds={new Set(settings.autoload ?? [])}
          running={running}
        />
      </div>

      <h3 className="mt-4 border-t pt-3 text-[11px] font-semibold uppercase tracking-wide text-ink-faint" style={{ borderColor: 'var(--line)' }}>
        Get more models
      </h3>
      <div className="mt-1.5">
        <CatalogBrowser onOpen={onOpenModel} query={query} onQuery={setQuery} hideSearch memory={memory} mlx={mlx} />
      </div>
    </div>
  );
}
