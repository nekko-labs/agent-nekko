import { useEffect, useState } from 'react';
import type { EngineSettings, LocalModel, ResidentModel } from '@agent-nekko/shared';
import { useStore } from '../../store.js';
import { formatBytes, formatTokens } from '../runtimes/verdict.js';

/**
 * The models actually in memory right now.
 *
 * "Loaded" used to be a badge on a row halfway down the library, which answered
 * the wrong question. What is resident is its own concern: how much of the
 * machine it holds, how long until each is evicted, and the two verbs that
 * change that (unload, keep). It sits above the library because it is the
 * answer to "what is running" rather than "what do I have".
 */

/** Countdown text is live for a minute-scale value; five seconds is enough. */
const TICK_MS = 5000;

export function ResidentModels({
  providerId,
  resident,
  models,
  settings,
  onChanged,
}: {
  providerId: string;
  resident: ResidentModel[];
  models: Array<LocalModel & { loaded: boolean }>;
  settings: EngineSettings;
  onChanged: () => void;
}) {
  const pushToast = useStore((s) => s.pushToast);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, []);

  const byId = new Map(models.map((m) => [m.id, m]));
  const totalBytes = resident.reduce((n, r) => n + (r.vramBytes ?? r.sizeBytes ?? 0), 0);

  const unload = async (id: string) => {
    setBusy(id);
    const res = await window.nekko
      .unloadModel(providerId, id)
      .catch(() => ({ ok: false, message: "Couldn't unload it." }));
    setBusy(null);
    pushToast(res.ok ? 'info' : 'error', res.message ?? 'Unloaded.');
    onChanged();
  };

  const setTtl = async (id: string, ttlSeconds: number) => {
    setBusy(id);
    const res = await window.nekko
      .engineSetResidentTtl(id, ttlSeconds)
      .catch((e: Error) => ({ ok: false, message: e.message }));
    setBusy(null);
    pushToast(res.ok ? 'success' : 'error', res.message);
    onChanged();
  };

  return (
    <div className="rounded-xl border p-3" style={{ borderColor: 'var(--line)', background: 'var(--surface-2)' }}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[12px] font-semibold">In memory</p>
        <p className="text-[11px] text-ink-faint">
          {resident.length === 0
            ? 'nothing loaded'
            : `${resident.length} of ${Math.max(1, settings.maxLoaded)} slot${Math.max(1, settings.maxLoaded) === 1 ? '' : 's'}` +
              (totalBytes > 0 ? ` · ${formatBytes(totalBytes)}` : '')}
        </p>
      </div>

      {resident.length === 0 ? (
        <p className="mt-1.5 text-[11.5px] text-ink-faint">
          Load a model below, or let one load itself when a request arrives
          {settings.jitLoad ? '' : ' (load-on-demand is off)'}.
        </p>
      ) : (
        <div className="mt-2 space-y-1.5">
          {resident.map((r) => {
            const model = byId.get(r.id);
            const idleFor = r.lastUsedAt ? now - r.lastUsedAt : 0;
            const evictIn = r.expiresAt ? r.expiresAt - now : undefined;
            const kept = !r.expiresAt;
            return (
              <div key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-2.5 py-2 text-[12px]" style={{ borderColor: 'var(--line)' }}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'var(--success)' }} />
                    <span className="truncate font-medium">{model?.name ?? r.id}</span>
                    {model?.modality && model.modality !== 'chat' && (
                      <span className="chip shrink-0 text-[10px]">{model.modality === 'vision' ? 'vision' : model.modality}</span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[11px] text-ink-faint">
                    {[
                      formatBytes(r.vramBytes ?? r.sizeBytes ?? 0),
                      r.contextLength ? `${formatTokens(r.contextLength)} context` : undefined,
                      idleFor > 20_000 ? `idle ${formatAge(idleFor)}` : 'in use',
                      evictIn !== undefined ? `unloads in ${formatAge(Math.max(0, evictIn))}` : 'stays loaded',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    className="rounded-full border px-2 py-1 text-[11px]"
                    style={{ borderColor: 'var(--line)' }}
                    disabled={busy === r.id}
                    title={
                      kept
                        ? `Unload after ${settings.idleTtlSeconds}s idle instead of staying resident`
                        : 'Keep this model loaded until you unload it'
                    }
                    onClick={() => void setTtl(r.id, kept ? settings.idleTtlSeconds : 0)}
                  >
                    {kept ? 'Use idle limit' : 'Keep loaded'}
                  </button>
                  <button
                    className="rounded-full border px-2 py-1 text-[11px]"
                    style={{ borderColor: 'var(--line)' }}
                    disabled={busy === r.id}
                    onClick={() => void unload(r.id)}
                  >
                    {busy === r.id ? 'unloading…' : 'Unload'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** "4m", "1h 12m", "2d" — ages, not timestamps. */
function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
