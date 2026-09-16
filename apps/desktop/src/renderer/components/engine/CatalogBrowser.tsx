import { useEffect, useState } from 'react';
import type { CatalogModel } from '@agent-nekko/shared';
import { ChevronIcon } from '../../icons.js';
import { formatBytes } from '../runtimes/verdict.js';

/**
 * Finding a model to run.
 *
 * Opens on a short curated list rather than an empty search box, because the
 * question a new user has is "what should I run", not "what exists". Search is
 * right there for everyone else, straight against Hugging Face.
 *
 * A row is a decision about which model, so it carries what separates one model
 * from another (size, what it is for, how many people pull it) and nothing else.
 * Choosing a build, reading the card, checking when it was last touched: that is
 * a different question, and it gets the model's own page rather than a drawer
 * unfolding inside a list.
 */

export function CatalogBrowser({ onOpen }: { onOpen: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const [models, setModels] = useState<CatalogModel[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    // Debounced so typing a model name does not fire a request per keystroke.
    const t = setTimeout(async () => {
      const res = await window.nekko.engineCatalog(query.trim() || undefined).catch(() => []);
      if (!live) return;
      setModels(res);
      setLoading(false);
    }, query ? 350 : 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query]);

  return (
    <div>
      <input
        className="input w-full text-[12.5px]"
        placeholder="Search Hugging Face for a model, e.g. qwen coder"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        spellCheck={false}
      />
      <p className="mt-1.5 text-[11px] text-ink-faint">
        {query
          ? 'Searching GGUF repositories on Hugging Face.'
          : 'A short starter list. Search above for anything else. Open any model for its card, its builds and its sizes.'}
      </p>

      {loading && <p className="mt-3 text-[12px] text-ink-faint">Looking…</p>}

      {!loading && models?.length === 0 && (
        <p className="mt-3 text-[12px] text-ink-faint">
          Nothing matched. Try a shorter search, or the publisher's name.
        </p>
      )}

      <div className="mt-2 space-y-1.5">
        {(models ?? []).map((m) => (
          <button
            key={m.id}
            className="catalog-row flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left"
            style={{ background: 'var(--surface-2)' }}
            onClick={() => onOpen(m.id)}
            title={`Open ${m.name}`}
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="truncate text-[12.5px] font-medium">{m.name}</span>
                {m.parameterSize && <span className="chip">{m.parameterSize}</span>}
                {m.tags.slice(0, 3).map((t) => (
                  <span key={t} className="text-[10px] text-ink-faint">
                    {t}
                  </span>
                ))}
                {m.gated && (
                  <span className="text-[10px]" style={{ color: 'var(--warning, #d1a054)' }} title="This repository needs accepted terms or a token">
                    gated
                  </span>
                )}
              </div>
              <p className="truncate text-[11px] text-ink-faint">
                {m.summary ??
                  [
                    m.owner,
                    m.downloads ? `${compact(m.downloads)} downloads` : null,
                    `${m.quants.length} build${m.quants.length === 1 ? '' : 's'}`,
                    smallest(m),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
              </p>
            </div>
            <ChevronIcon className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
          </button>
        ))}
      </div>
    </div>
  );
}

/** "from 4.4 GB": the smallest build, which is what decides whether it fits. */
function smallest(m: CatalogModel): string | null {
  const sizes = m.quants.map((q) => q.sizeBytes ?? 0).filter((n) => n > 0);
  return sizes.length ? `from ${formatBytes(Math.min(...sizes))}` : null;
}

function compact(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}
