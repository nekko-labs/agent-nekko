import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EngineStatus, GpuFit, KvCacheDtype, LoadParams, LocalModel, ResidentModel } from '@agent-nekko/shared';
import { readBrandKey } from '../../brandStorage.js';
import { useStore } from '../../store.js';
import { ChevronIcon } from '../../icons.js';
import { Toggle } from '../primitives/index.js';
import { formatBytes, formatTokens, placementLabel, placementTitle } from '../runtimes/verdict.js';

/**
 * What a loaded model is running on, one fold away in the right rail.
 *
 * The answer to "is it on the GPU" used to live on the Models page, which you
 * only see when you go looking. Here it sits where the question is asked —
 * beside the chat and above the machine's meters — and the same group lets you
 * change a resident model's settings and reload it without leaving the chat.
 * It only appears while the engine is installed: a dock about models you cannot
 * run is a decoration.
 */

const PROVIDER_ID = 'nekko-engine';
const POLL_MS = 6000;
const DOCK_OPEN_KEY = 'nekko.modelDock.open';
const CONTEXT_STOPS = [2048, 4096, 8192, 16384, 32768, 65536, 131072];

type Row = { model: LocalModel & { loaded: boolean; gpuFit?: GpuFit }; resident: ResidentModel };

export function ModelDock() {
  const pushToast = useStore((s) => s.pushToast);
  const [open, setOpen] = useState(() =>
    typeof window === 'undefined' ? true : readBrandKey(window.localStorage, DOCK_OPEN_KEY) !== 'off',
  );
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [models, setModels] = useState<Array<LocalModel & { loaded: boolean; gpuFit?: GpuFit }>>([]);
  // Which resident model's settings are unfolded.
  const [editing, setEditing] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [s, m] = await Promise.all([
      window.nekko.engineStatus().catch(() => null),
      window.nekko.engineModels().catch(() => []),
    ]);
    setStatus(s);
    setModels(m);
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const toggle = () =>
    setOpen((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(DOCK_OPEN_KEY, next ? 'on' : 'off');
      } catch {
        /* private mode */
      }
      return next;
    });

  const rows: Row[] = useMemo(() => {
    const byId = new Map(models.map((m) => [m.id, m]));
    return (status?.resident ?? [])
      .map((r) => ({ resident: r, model: byId.get(r.id) }))
      .filter((r): r is Row => Boolean(r.model));
  }, [status, models]);

  // No engine, no dock — nothing here could ever load a model.
  if (!status?.install.binPath) return null;

  return (
    <div className={`shrink-0 border-t border-line px-4 text-[11px] ${open ? 'py-4' : 'py-2'}`}>
      <button
        className="flex w-full items-center justify-between text-left"
        onClick={toggle}
        aria-expanded={open}
        title={open ? 'Collapse model settings' : 'Show the loaded models and their settings'}
      >
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
          <ChevronIcon className={`h-3 w-3 shrink-0 transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
          Model settings
          {rows.length > 0 && <span className="chip text-[9px]">{rows.length} loaded</span>}
        </span>
        {/* Collapsed, still say whether anything runs on the CPU: it is the one
            fact that explains a slow reply without opening the group. */}
        {!open && rows.some((r) => r.resident.loadedOn && r.resident.loadedOn !== 'gpu') && (
          <span className="shrink-0 text-[10px]" style={{ color: 'var(--warning, #d1a054)' }}>
            part on CPU
          </span>
        )}
      </button>

      {open && (
        <div className="mt-2.5 space-y-2">
          {status.running && rows.length === 0 && (
            <p className="text-[11px] leading-snug text-ink-faint">
              Nothing is in memory yet. Models load on the Models tab, or on their own when a request arrives.
            </p>
          )}
          {!status.running && (
            <p className="text-[11px] leading-snug text-ink-faint">
              The model server is stopped. Start it on the Nekko Server page to load models here.
            </p>
          )}
          {rows.map(({ model, resident }) => (
            <DockRow
              key={resident.id}
              model={model}
              resident={resident}
              expanded={editing === resident.id}
              onToggleExpand={() => setEditing(editing === resident.id ? null : resident.id)}
              onReloaded={(msg, ok) => {
                pushToast(ok ? 'success' : 'error', msg);
                setEditing(null);
                void refresh();
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** One resident model: where it runs, and folded under it the settings it runs with. */
function DockRow({
  model,
  resident,
  expanded,
  onToggleExpand,
  onReloaded,
}: {
  model: LocalModel & { loaded: boolean; gpuFit?: GpuFit };
  resident: ResidentModel;
  expanded: boolean;
  onToggleExpand: () => void;
  onReloaded: (message: string, ok: boolean) => void;
}) {
  const [params, setParams] = useState<LoadParams>(() => ({ ...(model.preset ?? {}) }));
  const [busy, setBusy] = useState(false);
  const split = resident.loadedOn === 'gpu+cpu' || resident.loadedOn === 'cpu';

  const reload = async () => {
    setBusy(true);
    const res = await window.nekko
      .runtimeLoad(PROVIDER_ID, model.id, params)
      .catch((e: Error) => ({ ok: false, message: e.message }));
    setBusy(false);
    onReloaded(res.message ?? (res.ok ? `${model.name} reloaded.` : 'Could not reload it.'), res.ok);
  };

  const patch = (p: Partial<LoadParams>) => setParams((prev) => ({ ...prev, ...p }));
  const ctxStops = CONTEXT_STOPS.filter((s) => s <= (model.maxContext ?? 131072));

  return (
    <div className="rounded-lg border border-line">
      <button
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
        onClick={onToggleExpand}
        aria-expanded={expanded}
        title={expanded ? 'Fold the settings away' : `Adjust and reload ${model.name}`}
      >
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: split ? 'var(--warning, #d1a054)' : 'var(--success)' }}
        />
        <span className="min-w-0 flex-1 truncate font-medium text-ink-soft" title={model.path}>
          {model.name}
        </span>
        {resident.loadedOn && (
          <span
            className="shrink-0 text-[10px] tabular-nums"
            style={split ? { color: 'var(--warning, #d1a054)' } : undefined}
            title={placementTitle(resident)}
          >
            {placementLabel(resident)}
          </span>
        )}
        <ChevronIcon className={`h-3 w-3 shrink-0 text-ink-faint transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`} />
      </button>

      {/* Where it sits and what it holds, at a glance. */}
      <p className="px-2.5 pb-1.5 text-[10px] tabular-nums text-ink-faint">
        {[
          formatBytes(resident.vramBytes ?? resident.sizeBytes ?? 0),
          resident.contextLength ? `${formatTokens(resident.contextLength)} context` : undefined,
          model.gpuFit && model.gpuFit !== 'full' && model.gpuFit !== 'unknown'
            ? model.gpuFit === 'wont'
              ? "won't fit this machine"
              : model.gpuFit === 'cpu'
                ? 'no GPU to offload to'
                : 'spills to CPU under current settings'
            : undefined,
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>

      {expanded && (
        <div className="space-y-2 border-t border-line px-2.5 py-2.5">
          <Field label="GPU layers" value={model.layers ? `${params.gpuLayers ?? model.layers}/${model.layers}` : 'all'}>
            {model.layers ? (
              <input
                type="range"
                className="w-full"
                min={0}
                max={model.layers}
                value={params.gpuLayers ?? model.layers}
                onChange={(e) => patch({ gpuLayers: Number(e.target.value) })}
              />
            ) : (
              <p className="text-[10px] text-ink-faint">This file does not say how many layers it has.</p>
            )}
          </Field>
          <Field label="Context">
            <select
              className="input w-full py-1 text-[11px]"
              value={params.contextTokens ?? resident.contextLength ?? 8192}
              onChange={(e) => patch({ contextTokens: Number(e.target.value) })}
            >
              {ctxStops.map((s) => (
                <option key={s} value={s}>
                  {formatTokens(s)} tokens
                </option>
              ))}
            </select>
          </Field>
          <Field label="KV cache">
            <select
              className="input w-full py-1 text-[11px]"
              value={params.kvCacheDtype ?? 'f16'}
              onChange={(e) => patch({ kvCacheDtype: e.target.value as KvCacheDtype })}
            >
              <option value="f16">f16 (full)</option>
              <option value="q8_0">q8_0 (half)</option>
              <option value="q4_0">q4_0 (quarter)</option>
            </select>
          </Field>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10.5px] text-ink-soft" title="Never evict it for sitting idle">
              Keep it loaded
            </span>
            <Toggle
              value={params.ttlSeconds === 0}
              onChange={(v) => patch({ ttlSeconds: v ? 0 : undefined })}
              label={`Keep ${model.name} loaded`}
            />
          </div>
          <p className="text-[10px] leading-snug text-ink-faint">
            Changes apply on reload: the model is unloaded and brought back with these settings.
          </p>
          <button
            className="btn btn-primary w-full py-1 text-[11px] disabled:opacity-60"
            disabled={busy}
            onClick={() => void reload()}
          >
            {busy ? 'Reloading…' : 'Reload with these settings'}
          </button>
        </div>
      )}
    </div>
  );
}

function Field({ label, value, children }: { label: string; value?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-[10.5px] text-ink-soft">{label}</span>
        {value && <span className="text-[10px] tabular-nums text-ink-faint">{value}</span>}
      </div>
      {children}
    </div>
  );
}
