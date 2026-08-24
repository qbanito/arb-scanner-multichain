export type AddressedMarket<Chain extends string, Pair> = {
  token: { addresses: Partial<Record<Chain, string>> };
  pairs: Pair[];
};

/**
 * Combine a partially refreshed catalog with the last real snapshot.
 *
 * Public indexers can throttle one token while returning every other token in
 * the same refresh. Keep the last non-empty market for that requested address,
 * accept every successful fresh market, and drop stale frontier tokens that
 * are no longer part of the current discovery set.
 */
export function mergeActiveMarketCatalog<
  Chain extends string,
  Pair,
  Market extends AddressedMarket<Chain, Pair>,
>(
  chain: Chain,
  requestedAddresses: ReadonlySet<string>,
  refreshed: Market[],
  previous: Market[],
): Market[] {
  const byAddress = new Map<string, Market>();

  for (const market of refreshed) {
    const address = market.token.addresses[chain]?.toLowerCase();
    if (!address || !requestedAddresses.has(address)) continue;
    byAddress.set(address, market);
  }

  for (const market of previous) {
    const address = market.token.addresses[chain]?.toLowerCase();
    if (!address || !requestedAddresses.has(address)) continue;
    const current = byAddress.get(address);
    if (!current || current.pairs.length === 0) byAddress.set(address, market);
  }

  return [...byAddress.values()].filter((market) => market.pairs.length > 0);
}
