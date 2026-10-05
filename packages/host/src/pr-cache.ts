export class PrReadCache<T> {
  private values = new Map<string, { value: T; at: number }>();
  private pending = new Map<string, Promise<T>>();
  constructor(private readonly ttlMs: number, private readonly now = Date.now) {}
  delete(key: string): void { this.values.delete(key); }
  async get(key: string, load: () => Promise<T>, force = false): Promise<T> {
    const pending = this.pending.get(key);
    if (pending) return pending;
    const hit = this.values.get(key);
    if (!force && hit && this.now() - hit.at < this.ttlMs) return hit.value;
    const request = Promise.resolve().then(load).then((value) => {
      this.values.set(key, { value, at: this.now() });
      return value;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }
}

export function githubReadCooldownMs(stderr: string): number {
  if (/secondary rate limit|abuse detection/i.test(stderr)) return 60_000;
  if (/API rate limit (?:already )?exceeded/i.test(stderr)) return 60 * 60_000;
  return 0;
}

/** Bound background GitHub reads across all sessions and branches. */
export class PrReadQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(read: () => Promise<T>): Promise<T> {
    const next = this.tail.then(read);
    this.tail = next.catch(() => {});
    return next;
  }
}
