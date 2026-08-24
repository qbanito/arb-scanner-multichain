type CandidateState = {
  waitCycles: number;
  lastSeenBlock: number;
  lastQuotedBlock: number;
};

export type QuoteQueueStats = {
  tracked: number;
  waiting: number;
  oldestWaitCycles: number;
};

/**
 * Fair, block-aware exact-quote scheduler.
 *
 * Candidate discovery can produce hundreds of cycles while an RPC can only
 * quote a bounded number per block. A pure top-N selection starves everything
 * below the cutoff forever. This scheduler keeps wait state between scans and
 * gradually promotes candidates that remain live, while still preferring the
 * strongest newly-discovered routes.
 */
export class FairQuoteScheduler {
  private readonly state = new Map<string, Map<string, CandidateState>>();

  constructor(
    private readonly agingSlotsPerCycle = 4,
    private readonly staleAfterBlocks = 64,
  ) {}

  select(queue: string, orderedCandidateIds: readonly string[], budget: number, blockNumber: number): Set<string> {
    if (budget <= 0 || orderedCandidateIds.length === 0) return new Set();
    const queueState = this.state.get(queue) ?? new Map<string, CandidateState>();
    this.state.set(queue, queueState);
    const live = new Set(orderedCandidateIds);

    for (const [id, entry] of queueState) {
      if (!live.has(id) && blockNumber - entry.lastSeenBlock > this.staleAfterBlocks) queueState.delete(id);
    }

    const ranked = orderedCandidateIds.map((id, rank) => {
      const entry = queueState.get(id) ?? { waitCycles: 0, lastSeenBlock: blockNumber, lastQuotedBlock: -1 };
      entry.lastSeenBlock = blockNumber;
      queueState.set(id, entry);
      return {
        id,
        // A candidate advances four positions for every scan it survives
        // without a quote. Stable opportunities therefore cannot starve.
        effectiveRank: rank - entry.waitCycles * this.agingSlotsPerCycle,
        rank,
      };
    });

    ranked.sort((a, b) => a.effectiveRank - b.effectiveRank || a.rank - b.rank || a.id.localeCompare(b.id));
    const selected = new Set(ranked.slice(0, Math.min(budget, ranked.length)).map(({ id }) => id));
    for (const id of orderedCandidateIds) {
      const entry = queueState.get(id)!;
      if (selected.has(id)) {
        entry.waitCycles = 0;
        entry.lastQuotedBlock = blockNumber;
      } else {
        entry.waitCycles++;
      }
    }
    return selected;
  }

  stats(queue: string): QuoteQueueStats {
    const entries = [...(this.state.get(queue)?.values() ?? [])];
    return {
      tracked: entries.length,
      waiting: entries.filter((entry) => entry.waitCycles > 0).length,
      oldestWaitCycles: entries.reduce((max, entry) => Math.max(max, entry.waitCycles), 0),
    };
  }
}

