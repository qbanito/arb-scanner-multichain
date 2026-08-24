function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Spaces request starts globally while allowing already-started HTTP calls to
 * overlap. That gives predictable API pressure without serializing network
 * latency itself.
 */
export class RateGate {
  private tail: Promise<void> = Promise.resolve();
  private nextStartAt = 0;

  constructor(private readonly minimumGapMs: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const delay = Math.max(0, this.nextStartAt - Date.now());
    if (delay > 0) await wait(delay);
    this.nextStartAt = Date.now() + this.minimumGapMs;
    release();
    return task();
  }
}
