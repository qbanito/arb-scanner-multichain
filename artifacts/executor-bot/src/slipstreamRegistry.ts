export type SlipstreamDeployment = { quoter: `0x${string}`; router: `0x${string}` };

const DEPLOYMENTS: Record<number, Record<string, SlipstreamDeployment>> = {
  8453: {
    "0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a": { quoter: "0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0", router: "0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5" },
    "0xade65c38cd4849adba595a4323a8c7ddfe89716a": { quoter: "0x3d4C22254F86f64B7eC90ab8F7aeC1FBFD271c6C", router: "0xcbBb8035cAc7D4B3Ca7aBb74cF7BdF900215Ce0D" },
    "0xf8f2eb4940cfe7d13603dddd87f123820fc061ef": { quoter: "0x514c8B5f54112481E28028F1166Bd78501089259", router: "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F" },
  },
  10: {
    "0xcc0bddb707055e04e497ab22a59c2af4391cd12f": { quoter: "0x89D8218ed5fF1e46d8dcd33fb0bbeE3be1621466", router: "0x0792a633F0c19c351081CF4B211F68F79bCc9676" },
    "0xe13dd1fba721aa81a1826d9523ac9bc7d260c879": { quoter: "0xAd432b2ca49965266133F2bd4c17dc1Ec12f5DEB", router: "0xbA3aEe516399388C779463183d00bB579f5041Ca" },
  },
};

export function slipstreamDeployment(chainId: number, factory: string): SlipstreamDeployment | null {
  return DEPLOYMENTS[chainId]?.[factory.toLowerCase()] ?? null;
}

