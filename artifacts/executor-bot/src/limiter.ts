/// In-memory rolling-window trade rate limiter. Resets on process restart —
/// intentionally conservative, since a restarted bot re-earning its budget
/// from zero is safer than one that remembers nothing and free-fires.
export class TradeLimiter {
  private timestamps: number[] = [];

  constructor(private readonly maxPerHour: number) {}

  canTrade(): boolean {
    this.prune();
    return this.timestamps.length < this.maxPerHour;
  }

  record(): void {
    this.timestamps.push(Date.now());
  }

  private prune(): void {
    const cutoff = Date.now() - 60 * 60 * 1000;
    this.timestamps = this.timestamps.filter((ts) => ts > cutoff);
  }
}
