import { useState } from 'react';
import type { LocalModel } from '@agent-nekko/shared';
import { useStore } from '../../store.js';
import { CheckIcon, TrashIcon } from '../../icons.js';
import { formatBytes, formatTokens } from '../runtimes/verdict.js';
import { EngineLoadDrawer } from './EngineLoadDrawer.js';

/**
 * The models on this machine.
 *
 * A row is a whole model's state in one line: what it is, whether it is in
 * memory, and the one action that changes that. Settings live behind the row
 * rather than on it, because the common case is "load this" and the uncommon one
 * is "load this with 32k context and a quantized KV cache".
 */

export function ModelLibrary({
  providerId,
  models,
  onChanged,
}: {
  providerId: string;
  models: Array<LocalModel & { loaded: boolean }>;
  onChanged: () => void;
}) {
  const pushToast = useStore((s) => s.pushToast);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importPath, setImportPath] = useState('');

  const unload = async (id: string) => {
    setBusy(id);
    const res = await window.nekko
      .unloadModel(providerId, id)
      .catch(() => ({ ok: false, message: "Couldn't unload it." }));
    setBusy(null);
    pushToast(res.ok ? 'info' : 'error', res.message ?? 'Unloaded.');
    onChanged();
  };

  const quickLoad = async (model: LocalModel & { loaded: boolean }) => {
    setBusy(model.id);
    // A row's Load uses whatever this model was last saved with, and the planner's
    // own answer when it has never been configured. Opening the drawer is for
    // changing that, not for performing it.
    const params = model.preset ? { ...model.preset, budgetFraction: undefined } : null;
    const res = params
      ? await window.nekko.runtimeLoad(providerId, model.id, params)
      : await autoLoad(providerId, model.id);
    setBusy(null);
    pushToast(res.ok ? 'success' : 'error', res.message ?? (res.ok ? 'Loaded.' : "Couldn't load it."));
    onChanged();
  };

  const remove = async (model: LocalModel) => {
    if (!window.confirm(`Delete ${model.name}? The file is removed from disk.`)) return;
    const res = await window.nekko.engineDeleteModel(model.id);
    pushToast(res.ok ? 'success' : 'error', res.message);
    onChanged();
  };

  const runImport = async () => {
    const path = importPath.trim();
    if (!path) return;
    const res = await window.nekko.engineImportModel(path);
    pushToast(res.ok ? 'success' : 'error', res.message);
    if (res.ok) {
      setImportPath('');
      setImporting(false);
      onChanged();
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="text-[11.5px] text-ink-faint">
          {models.length === 0
            ? 'No models yet.'
            : `${models.length} model${models.length === 1 ? '' : 's'} · ${formatBytes(
                models.reduce((n, m) => n + m.sizeBytes, 0),
              )} on disk`}
        </p>
        <button className="text-[11.5px] text-ink-faint hover:text-ink" onClick={() => setImporting((v) => !v)}>
          Add a file I already have
        </button>
      </div>

      {importing && (
        <div className="mt-2 flex gap-2">
          <input
            className="input flex-1 font-mono text-[12px]"
            placeholder="C:\\models\\qwen2.5-7b-instruct-q4_k_m.gguf"
            value={importPath}
            onChange={(e) => setImportPath(e.target.value)}
            spellCheck={false}
          />
          <button className="btn btn-outline py-1.5 text-[12px]" onClick={runImport} disabled={!importPath.trim()}>
            Add
          </button>
        </div>
      )}

      {models.length === 0 ? (
        <p className="mt-3 rounded-xl border border-dashed px-4 py-3.5 text-[12.5px] text-ink-faint" style={{ borderColor: 'var(--line)' }}>
          Nothing here yet. Open <strong>Find models</strong> to download one, or point at a GGUF you already have.
        </p>
      ) : (
        <div className="mt-2 space-y-1.5">
          {models.map((m) => (
            <div key={m.id}>
              <div
                className="flex flex-wrap items-center gap-2 rounded-lg px-2.5 py-2 text-[12.5px]"
                style={{ background: 'var(--surface-2)' }}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-medium">{m.name}</span>
                    {m.loaded && (
                      <span
                        className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] text-white"
                        style={{ background: 'var(--success)' }}
                      >
                        <CheckIcon className="h-2.5 w-2.5" /> in memory
                      </span>
                    )}
                  </div>
                  <p className="truncate text-[11px] text-ink-faint">
                    {[
                      m.quantization,
                      m.parameterSize,
                      formatBytes(m.sizeBytes),
                      m.maxContext && `${formatTokens(m.maxContext)} max context`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    className="rounded-full border px-2 py-1 text-[11px] hover:border-[var(--accent)]"
                    style={{ borderColor: open === m.id ? 'var(--accent)' : 'var(--line)' }}
                    onClick={() => setOpen(open === m.id ? null : m.id)}
                  >
                    Settings
                  </button>
                  {m.loaded ? (
                    <button
                      className="rounded-full border px-2 py-1 text-[11px]"
                      style={{ borderColor: 'var(--line)' }}
                      disabled={busy === m.id}
                      onClick={() => void unload(m.id)}
                    >
                      {busy === m.id ? 'unloading…' : 'Unload'}
                    </button>
                  ) : (
                    <button
                      className="rounded-full px-2.5 py-1 text-[11px] text-white"
                      style={{ background: 'var(--accent)' }}
                      disabled={busy === m.id}
                      onClick={() => void quickLoad(m)}
                    >
                      {busy === m.id ? 'loading…' : 'Load'}
                    </button>
                  )}
                  <button className="btn btn-ghost px-1.5 py-1" title="Delete this model" onClick={() => void remove(m)}>
                    <TrashIcon className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              {open === m.id && (
                <EngineLoadDrawer
                  providerId={providerId}
                  model={m}
                  onDone={onChanged}
                  onClose={() => setOpen(null)}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Load with the planner's own answer at a middling budget.
 *
 * A model nobody has configured still has to load sensibly, and asking the same
 * planner the drawer asks means the quick path and the considered path cannot
 * disagree.
 */
async function autoLoad(providerId: string, modelId: string): Promise<{ ok: boolean; message?: string }> {
  const auto = await window.nekko.runtimeAutoFit(providerId, modelId, 0.75).catch(() => null);
  return window.nekko.runtimeLoad(providerId, modelId, {
    contextTokens: auto?.request.contextTokens,
    kvCacheDtype: auto?.request.kvCacheDtype,
    gpuLayers:
      auto?.plan.totalLayers && auto.request.gpuLayerFraction < 1
        ? Math.round(auto.plan.totalLayers * auto.request.gpuLayerFraction)
        : undefined,
  });
}
