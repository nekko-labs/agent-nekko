import { useEffect, useState } from 'react';
import type { CatalogModel, CatalogQuant } from '@agent-nekko/shared';
import { useStore } from '../../store.js';
import { DownloadIcon } from '../../icons.js';
import { formatBytes } from '../runtimes/verdict.js';

/**
 * Finding a model to run.
 *
 * Opens on a short curated list rather than an empty search box, because the
 * question a new user has is "what should I run", not "what exists". Search is
 * right there for everyone else, straight against Hugging Face.
 *
 * The quantization picker is the one genuinely confusing choice here, so it is
 * spelled out: each build shows its real download size, and the one most people
 * want says so.
 */

export function CatalogBrowser({ onQueued }: { onQueued: () => void }) {
  const pushToast = useStore((s) => s.pushToast);
  const [query, setQuery] = useState('');
  const [models, setModels] = useState<CatalogModel[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);

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

  const download = async (model: CatalogModel, quant: CatalogQuant) => {
    const res = await window.nekko.engineDownloadModel(model.id, quant.label);
    pushToast(res.ok ? 'info' : 'error', res.message);
    if (res.ok) onQueued();
  };

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
          : 'A short starter list. Search above for anything else.'}
      </p>

      {loading && <p className="mt-3 text-[12px] text-ink-faint">Looking…</p>}

      {!loading && models?.length === 0 && (
        <p className="mt-3 text-[12px] text-ink-faint">
          Nothing matched. Try a shorter search, or the publisher's name.
        </p>
      )}

      <div className="mt-2 space-y-1.5">
        {(models ?? []).map((m) => (
          <div key={m.id} className="rounded-lg px-2.5 py-2" style={{ background: 'var(--surface-2)' }}>
            <div className="flex flex-wrap items-center gap-2">
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
                  {m.summary ?? `${m.owner}${m.downloads ? ` · ${compact(m.downloads)} downloads` : ''}`}
                </p>
              </div>
              <button
                className="shrink-0 rounded-full border px-2 py-1 text-[11px] hover:border-[var(--accent)]"
                style={{ borderColor: open === m.id ? 'var(--accent)' : 'var(--line)' }}
                onClick={() => setOpen(open === m.id ? null : m.id)}
              >
                {open === m.id ? 'Hide builds' : `${m.quants.length} build${m.quants.length === 1 ? '' : 's'}`}
              </button>
            </div>

            {open === m.id && (
              <div className="mt-2 space-y-1 border-t pt-2" style={{ borderColor: 'var(--line)' }}>
                {m.quants.map((q) => (
                  <div key={q.label} className="flex flex-wrap items-center gap-2 text-[11.5px]">
                    <span className="font-mono">{q.label}</span>
                    <span className="text-ink-faint">{q.sizeBytes ? formatBytes(q.sizeBytes) : 'size unknown'}</span>
                    {q.note && <span className="min-w-0 flex-1 truncate text-[11px] text-ink-faint">{q.note}</span>}
                    <button
                      className="ml-auto shrink-0 rounded-full px-2.5 py-1 text-[11px] text-white"
                      style={{ background: 'var(--accent)' }}
                      onClick={() => void download(m, q)}
                    >
                      <DownloadIcon className="mr-1 inline h-3 w-3" />
                      Download
                    </button>
                  </div>
                ))}
                <p className="pt-1 text-[10.5px] text-ink-faint">
                  Published by {m.owner}
                  {m.license ? ` · ${m.license}` : ''}. Downloads come straight from Hugging Face.
                </p>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function compact(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}
