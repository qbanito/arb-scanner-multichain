/// Assets this bot is willing to hold mid-liquidation (as debt or
/// collateral), restricted to the same verified set already allow-listed on
/// ArbExecutor for arbitrage — see artifacts/api-server/src/routes/scanner.ts
/// TOKEN_DEFINITIONS and dexRegistry.ts's stablecoin list. A liquidation
/// touching any other asset is skipped rather than guessed.
export const KNOWN_ASSETS: Record<number, Record<string, number>> = {
  42161: {
    "0x82af49447d8a07e3bd95bd0d56f35241523fbab1": 18, // WETH
    "0xaf88d065e77c8cc2239327c5edb3a432268e5831": 6, // USDC
    "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": 6, // USDT
    "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1": 18, // DAI
    "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f": 8, // WBTC
    "0x912ce59144191c1204e64559fe8253a0e49e6548": 18, // ARB
    // Verified against bgd-labs/aave-address-book AaveV3Arbitrum.sol
    // (*_UNDERLYING constants) + on-chain bytecode/decimals(). This is now
    // the complete set of Aave V3 Arbitrum reserves (as of writing).
    "0x5979d7b546e38e414f7e9822514be443a4800529": 18, // wstETH
    "0xec70dcb4a1efa46b8f2d97c310c9c4790ba5ffa8": 18, // rETH
    "0x35751007a407ca6feffe80b3cb397736d2cf4dbe": 18, // weETH
    "0xf97f4df75117a78c1a5a0dbb814af92458539fb4": 18, // LINK
    "0xba5ddd1f9d7f570dc94a51479a000e3bce967196": 18, // AAVE
    "0xd22a58f79e9481d1a88e00c343885a588b34b68b": 2, // EURS
    "0x3f56e0c36d275367b8c502090edf38289b3dea0d": 18, // MAI
    "0x93b346b6bc2548da6a1e7d98e9a421b42541425b": 18, // LUSD
    "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8": 6, // USDC.e (bridged)
    "0x17fc002b466eec40dae837fc4be5c67993ddbd6f": 18, // FRAX
    "0x7dff72693f6a4149b17e7c6314655f6a9f7c8b33": 18, // GHO
    "0x2416092f143378750bb29b79ed961ab195cceea5": 18, // ezETH
    "0x4186bfc76e2e237523cbc30fd220fe055156b41f": 18, // rsETH
    "0x6c84a8f1c29108f47a79964b5fe888d4f4d0de40": 18, // tBTC
  },
  // Verified against bgd-labs/aave-address-book AaveV3Ethereum.sol
  // (*_UNDERLYING constants) + on-chain bytecode/decimals() — matches
  // artifacts/api-server/src/lib/aave.ts's Ethereum KNOWN_ASSETS exactly.
  1: {
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": 18, // WETH
    "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0": 18, // wstETH
    "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": 8, // WBTC
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": 6, // USDC
    "0x6b175474e89094c44da98b954eedeac495271d0f": 18, // DAI
    "0x514910771af9ca656af840dff83e8264ecf986ca": 18, // LINK
    "0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9": 18, // AAVE
    "0xbe9895146f7af43049ca1c1ae358b0541ea49704": 18, // cbETH
    "0xdac17f958d2ee523a2206206994597c13d831ec7": 6, // USDT
    "0xae78736cd615f374d3085123a210448e74fc6393": 18, // rETH
    "0x5f98805a4e8be255a32880fdec7f6728c6568ba0": 18, // LUSD
    "0xd533a949740bb3306d119cc777fa900ba034cd52": 18, // CRV
    "0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2": 18, // MKR
    "0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f": 18, // SNX
    "0xba100000625a3754423978a60c9317c58a424e3d": 18, // BAL
    "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984": 18, // UNI
    "0x5a98fcbea516cf06857215779fd812ca3bef1b32": 18, // LDO
    "0xc18360217d8f7ab5e7c516566761ea12ce7f9d72": 18, // ENS
    "0x111111111117dc0aa78b770fa6a738034120c302": 18, // 1INCH
    "0x853d955acef822db058eb8505911ed77f175b99e": 18, // FRAX
    "0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f": 18, // GHO
    "0xd33526068d116ce69f19a9ee46f0bd304f21a51f": 18, // RPL
    "0x83f20f44975d03b1b09e64809b757c47f942beea": 18, // sDAI
    "0xaf5191b0de278c7286d6c7cc6ab6bb8a73ba2cd6": 18, // STG
    "0xdefa4e8a7bcba345f687a2f1456f5edd9ce97202": 18, // KNC
    "0x3432b6a60d23ca0dfca7761b7ab56459d9c964d0": 18, // FXS
    "0xf939e0a03fb07f59a73314e73794be0e57ac1b4e": 18, // crvUSD
    "0x6c3ea9036406852006290770bedfcaba0e23a0e8": 6, // PYUSD
    "0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee": 18, // weETH
    "0xf1c9acdc66974dfb6decb12aa385b9cd01190e38": 18, // osETH
    "0x4c9edd5852cd905f086c759e8383e09bff1e68b3": 18, // USDe
    "0xa35b1b31ce002fbf2058d22f30f95d405200a15b": 18, // ETHx
    "0x9d39a5de30e57443bff2a8307a4256c8797a3497": 18, // sUSDe
    "0x18084fba666a33d37592fa2633fd49a74dd93a88": 18, // tBTC
    "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": 8, // cbBTC
    "0xdc035d45d973e3ec169d2276ddab16f1e407384f": 18, // USDS
    "0xa1290d69c65a6fe4df752f95823fae25cb99e5a7": 18, // rsETH
    "0x8236a87084f8b84306f72007f36f2618a5634494": 8, // LBTC
    "0x657e8c867d8b37dcc18fa4caead9c45eb088c642": 8, // eBTC
    "0x8292bb45bf1ee4d140127049757c2e0ff06317ed": 18, // RLUSD
    "0xc139190f447e929f090edeb554d95abb8b18ac1c": 18, // USDtb
    "0x90d2af7d622ca3141efa4d8f1f24d86e5974cc8f": 18, // eUSDe
    "0xc96de26018a54d51c097160568752c4e3bd6c364": 8, // FBTC
    "0x1abaea1f7c830bd89acc67ec4af516284b1bc33c": 6, // EURC
    "0xd11c452fc99cf405034ee446803b6f6c1f6d5ed8": 18, // tETH
    "0xbf5495efe5db9ce00f80364c8b423567e58d2110": 18, // ezETH
    "0x68749665ff8d2d112fa859aa293f07a622782f38": 6, // XAUt
    "0xaca92e438df0b2401ff60da7e4337b687a2435da": 6, // mUSD
    "0x356b8d89c1e1239cbbb9de4815c39a1474d5ba7d": 6, // syrupUSDT
    "0xe343167631d89b6ffc58b88d6b7fb0228795491d": 6, // USDG
    "0xb0f70c0bd6fd87dbeb7c10dc692a2a6106817072": 8, // BTCb
  },
};

export function isKnownAsset(chainId: number, address: string): boolean {
  return address.toLowerCase() in (KNOWN_ASSETS[chainId] ?? {});
}

export function knownAssetDecimals(chainId: number, address: string): number | null {
  return KNOWN_ASSETS[chainId]?.[address.toLowerCase()] ?? null;
}
