import type { ResidentModel, RuntimeStatus } from '@agent-nekko/shared';
import { formatBytes } from './runtimes/verdict.js';

export function localRuntimeMetrics(statuses: RuntimeStatus[], now = Date.now()): { loadedModels: string; memoryLabel: string; lastTokPerSecond: string; recent: Array<{ id: string; placement?: string; lastUsed?: string }> } {
  const resident = statuses.flatMap((s) => s.resident ?? []);
  const vram = resident.reduce((n, r) => n + (r.vramBytes ?? 0), 0);
  const total = resident.reduce((n, r) => n + (r.sizeBytes ?? 0), 0);
  const byRecent = [...resident].sort((a, b) => (b.lastUsedAt ?? b.startedAt ?? 0) - (a.lastUsedAt ?? a.startedAt ?? 0)).slice(0, 3);
  return {
    loadedModels: resident.length ? String(resident.length) : statuses.some((s) => s.running) ? 'None loaded' : 'Runtime stopped or unavailable',
    memoryLabel: resident.length === 0 ? 'Unavailable' : [vram > 0 ? formatBytes(vram) + ' VRAM' : null, total > 0 ? formatBytes(total) + ' total' : null].filter(Boolean).join(' / ') || 'Reported without byte totals',
    lastTokPerSecond: runtimeTokPerSecond(statuses) ?? 'Unavailable',
    recent: byRecent.map((r) => ({ id: r.id, placement: placementSummary(r), lastUsed: r.lastUsedAt ? age(now - r.lastUsedAt) : undefined })),
  };
}

function runtimeTokPerSecond(_statuses: RuntimeStatus[]): string | null {
  // RuntimeStatus currently reports queue/KV-cache highlights and residency, not throughput.
  return null;
}

function placementSummary(r: ResidentModel): string | undefined {
  if (r.loadedOn === 'gpu') return 'GPU';
  if (r.loadedOn === 'gpu+cpu') return 'GPU + CPU';
  if (r.loadedOn === 'cpu') return 'CPU';
  return undefined;
}

function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60);
  return h + ' hr ago';
}
