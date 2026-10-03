/** Short relative time, in the desktop's wording ("now", "5 mins", "3 hrs", "2 days"). */
export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} ${m === 1 ? 'min' : 'mins'}`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ${h === 1 ? 'hr' : 'hrs'}`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} ${d === 1 ? 'day' : 'days'}`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo} ${mo === 1 ? 'month' : 'months'}`;
  const y = Math.round(d / 365);
  return `${y} ${y === 1 ? 'yr' : 'yrs'}`;
}
