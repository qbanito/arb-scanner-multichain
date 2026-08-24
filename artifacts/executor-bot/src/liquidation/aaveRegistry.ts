/// Aave V3 addresses, verified against bgd-labs/aave-address-book
/// (AaveV3Arbitrum.sol / AaveV3Ethereum.sol / AaveV3EthereumLido.sol /
/// AaveV3EthereumEtherFi.sol — POOL / ORACLE / AAVE_PROTOCOL_DATA_PROVIDER)
/// — same source and same rigor as the addresses in ../dexRegistry.ts. Kept
/// in sync with artifacts/api-server/src/lib/aave.ts's AAVE_MARKETS, which
/// is the source of the `poolAddress`/`market` fields this bot receives from
/// the watchlist API.
///
/// A chain can have several *isolated* Aave V3 markets — separate Pool
/// deployments with their own borrowers/reserves, not just separate assets
/// in one Pool. Ethereum alone has Main, Lido, and EtherFi markets (plus a
/// Horizon RWA market deliberately left out — its reserves are near-
/// certainly permissioned/whitelisted-transfer tokens, the same category of
/// problem as Pendle PT tokens in knownAssets.ts, so this bot could never
/// actually swap seized collateral for them on any supported DEX).
export type AaveMarket = {
  chainId: number;
  marketKey: string;
  pool: `0x${string}`;
  oracle: `0x${string}`;
  dataProvider: `0x${string}`;
  subgraphId: string;
};

export const AAVE_MARKETS: AaveMarket[] = [
  {
    chainId: 1,
    marketKey: "main",
    pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
    oracle: "0x54586bE62E3c3580375aE3723C145253060Ca0C2",
    dataProvider: "0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD",
    subgraphId: "Cd2gEDVeqnjBn1hSeqFMitw8Q1iiyV9FYUZkLNRcL87g",
  },
  {
    chainId: 1,
    marketKey: "lido",
    pool: "0x4e033931ad43597d96D6bcc25c280717730B58B1",
    oracle: "0xE3C061981870C0C7b1f3C4F4bB36B95f1F260BE6",
    dataProvider: "0xB85B2bFEbeC4F5f401dbf92ac147A3076391fCD5",
    subgraphId: "5vxMbXRhG1oQr55MWC5j6qg78waWujx1wjeuEWDA6j3",
  },
  {
    chainId: 1,
    marketKey: "etherfi",
    pool: "0x0AA97c284e98396202b6A04024F5E2c65026F3c0",
    oracle: "0x43b64f28A678944E0655404B0B98E443851cC34F",
    dataProvider: "0x7c8509591f9693D21280d96e149a08A3bf69Cd0c",
    subgraphId: "8o4HGApJkAqnvxAHShG4w5xiXihHyL7HkeDdQdRUYmqZ",
  },
  {
    chainId: 42161,
    marketKey: "main",
    pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    oracle: "0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7",
    dataProvider: "0x243Aa95cAC2a25651eda86e80bEe66114413c43b",
    subgraphId: "DLuE98kEb5pQNXAcKFQGQgfSQ57Xdou4jnVbAEqMfy3B",
  },
];

export function marketsForChain(chainId: number): AaveMarket[] {
  return AAVE_MARKETS.filter((m) => m.chainId === chainId);
}

export function marketByPool(pool: string): AaveMarket | null {
  return AAVE_MARKETS.find((m) => m.pool.toLowerCase() === pool.toLowerCase()) ?? null;
}
