/** Idle quotas refresh each minute; active subscription quotas twice as often. */
export function limitsRefreshInterval(active: boolean): number {
  return active ? 30_000 : 60_000;
}

export function nextLimitsRefresh(keys: string[], lastRead: ReadonlyMap<string, number>, active: ReadonlySet<string>, now: number): number | null {
  if (keys.length === 0) return null;
  return Math.min(...keys.map(key => (lastRead.get(key) ?? now) + limitsRefreshInterval(active.has(key))));
}
