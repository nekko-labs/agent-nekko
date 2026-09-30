/** Nearest-rank percentile: the smallest sample at or above `p` of the set. */
export function percentile(samples, p) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

export function summarize(samples) {
  const n = samples.length;
  if (!n) return { n: 0, p50: null, p95: null, p99: null, max: null, mean: null };
  const round = (v) => Math.round(v * 100) / 100;
  return {
    n,
    p50: round(percentile(samples, 50)),
    p95: round(percentile(samples, 95)),
    p99: round(percentile(samples, 99)),
    max: round(Math.max(...samples)),
    mean: round(samples.reduce((a, b) => a + b, 0) / n),
  };
}
