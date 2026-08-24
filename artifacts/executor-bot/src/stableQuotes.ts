/// Quote tokens this bot treats as ~$1, so `MAX_BORROW_USD` can be sized
/// directly into token units without a separate price oracle call. A quote
/// token outside this list (e.g. WETH) is skipped rather than mis-priced —
/// sizing a WETH-quoted borrow off a USD figure would require WETH's own
/// USD price, which the scanner API does not currently provide.
///
/// Addresses match artifacts/api-server/src/routes/scanner.ts's own
/// TOKEN_DEFINITIONS (USDC, USDT, DAI), the same values already serving the
/// live scanner, kept consistent rather than re-verified independently.
export const STABLE_QUOTE_TOKENS: Record<number, Set<string>> = {
  1: new Set(
    [
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
      "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
      "0x6B175474E89094C44Da98b954EedeAC495271d0F", // DAI
      "0x40D16FC0246aD3160Ccc09b8D0D3A2cd28aE6C2f", // GHO — Aave's own stablecoin, verified against knownAssets.ts
    ].map((address) => address.toLowerCase()),
  ),
  42161: new Set(
    [
      "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // USDC
      "0xFd086Bc7CD5C481dcc9C85ebe478A1C0b69FCbb9", // USDT
      "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", // DAI
      "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", // USDC.e (bridged) — was missing, caused liquidation-profit USD pricing to fail
      "0x7dfF72693f6A4149b17e7C6314655f6A9F7c8B33", // GHO
    ].map((address) => address.toLowerCase()),
  ),
  10: new Set(
    [
      "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", // native USDC
      "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", // USDT
      "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", // DAI
    ].map((address) => address.toLowerCase()),
  ),
  137: new Set(
    [
      "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", // native USDC
      "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", // USDT
      "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", // DAI
    ].map((address) => address.toLowerCase()),
  ),
  8453: new Set(["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", "0x6Bb7a212910682DCFdbd5BCBb3e28FB4E8da10Ee"].map((address) => address.toLowerCase())),
  43114: new Set(["0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", "0xd586E7F844cEa2F87f50152665BCbc2C279D8d70", "0xD24C2Ad096400B6FBcd2ad8B24E7acBc21A1da64", "0xfc421aD3C883Bf9E7C4f42dE845C4e4405799e73"].map((address) => address.toLowerCase())),
  56: new Set(["0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", "0x55d398326f99059fF775485246999027B3197955", "0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409", "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d"].map((address) => address.toLowerCase())),
  42220: new Set(["0xcebA9300f2b948710d2653dD7B07f33A8B32118C", "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", "0x765DE816845861e75A25fCA122bb6898B8B1282a"].map((address) => address.toLowerCase())),
  59144: new Set(["0x176211869cA2b568f2A7D4EE941E073a821EE1ff", "0xA219439258ca9da29E9Cc4cE5596924745e12B93"].map((address) => address.toLowerCase())),
  5000: new Set(["0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9", "0x779Ded0c9e1022225f8E0630b35a9b54bE713736", "0xfc421aD3C883Bf9E7C4f42dE845C4e4405799e73"].map((address) => address.toLowerCase())),
  534352: new Set(["0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4"].map((address) => address.toLowerCase())),
  146: new Set(["0x29219dd400f2Bf60E5a23d13Be72B486D4038894"].map((address) => address.toLowerCase())),
  324: new Set(["0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4", "0x493257fD37EDB34451f62EDf8D2a0C418852bA4C"].map((address) => address.toLowerCase())),
  1868: new Set(["0xbA9986D2381edf1DA03B0B9c1f8b00dc4AacC369", "0x3A337a6adA9d885b6Ad95ec48F9b75f197b5AE35"].map((address) => address.toLowerCase())),
};

export function isStableQuote(chainId: number, address: string): boolean {
  return STABLE_QUOTE_TOKENS[chainId]?.has(address.toLowerCase()) ?? false;
}
