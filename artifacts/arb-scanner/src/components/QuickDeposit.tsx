import { useEffect, useState } from "react";
import {
  CircleCheck,
  Copy,
  ExternalLink,
  Fuel,
  LoaderCircle,
  RefreshCw,
  WalletCards,
} from "lucide-react";
import {
  getGetScannerFundingQueryKey,
  useGetScannerFunding,
} from "@workspace/api-client-react";

type Eip1193Provider = {
  request: (args: {
    method: string;
    params?: unknown[] | Record<string, unknown>;
  }) => Promise<unknown>;
};

type ProviderError = Error & { code?: number };

const WEI_PER_NATIVE = 1_000_000_000_000_000_000n;

function injectedProvider(): Eip1193Provider | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { ethereum?: Eip1193Provider }).ethereum;
}

function formatNativeWei(raw: string, maximumFractionDigits = 8): string {
  const value = BigInt(raw);
  const whole = value / WEI_PER_NATIVE;
  const fraction = (value % WEI_PER_NATIVE)
    .toString()
    .padStart(18, "0")
    .slice(0, maximumFractionDigits)
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function parseNativeAmount(value: string): bigint {
  const normalized = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{0,18})?$/.test(normalized)) {
    throw new Error("Enter a valid amount with no more than 18 decimals.");
  }
  const [whole = "0", fraction = ""] = normalized.split(".");
  const wei =
    BigInt(whole) * WEI_PER_NATIVE + BigInt(fraction.padEnd(18, "0") || "0");
  if (wei <= 0n)
    throw new Error("The deposit amount must be greater than zero.");
  return wei;
}

function walletErrorMessage(error: unknown): string {
  const providerError = error as ProviderError;
  if (providerError?.code === 4001)
    return "The wallet request was rejected. No funds were sent.";
  if (providerError?.code === 4100)
    return "The wallet did not authorize the selected account.";
  if (providerError?.code === 4902)
    return "Add this network to your wallet, then try again.";
  return providerError?.message || "The wallet could not submit the deposit.";
}

export function QuickDeposit({
  chainId,
  executorDeployed,
}: {
  chainId: number;
  executorDeployed: boolean;
}) {
  const funding = useGetScannerFunding(chainId, {
    query: {
      enabled: chainId > 0 && executorDeployed,
      queryKey: getGetScannerFundingQueryKey(chainId),
      staleTime: 10_000,
      refetchInterval: 15_000,
      retry: 1,
    },
  });
  const [amount, setAmount] = useState("");
  const [state, setState] = useState<"idle" | "wallet" | "submitted" | "error">(
    "idle",
  );
  const [message, setMessage] = useState("");
  const [txHash, setTxHash] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!funding.data) return;
    setAmount(
      funding.data.recommendedDepositWei === "0"
        ? ""
        : formatNativeWei(funding.data.recommendedDepositWei, 8),
    );
    setState("idle");
    setMessage("");
    setTxHash("");
  }, [chainId, funding.data?.operatorAddress]);

  useEffect(() => {
    if (!txHash) return;
    const first = window.setTimeout(() => void funding.refetch(), 6_000);
    const second = window.setTimeout(() => void funding.refetch(), 18_000);
    return () => {
      window.clearTimeout(first);
      window.clearTimeout(second);
    };
  }, [txHash, funding.refetch]);

  const copyOperator = async () => {
    if (!funding.data) return;
    await navigator.clipboard?.writeText(funding.data.operatorAddress);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  const deposit = async () => {
    if (!funding.data || state === "wallet") return;
    setState("wallet");
    setMessage("");
    setTxHash("");

    try {
      const value = parseNativeAmount(amount);
      const provider = injectedProvider();
      if (!provider)
        throw new Error("No EVM wallet was detected in this browser.");

      let accounts = (await provider.request({
        method: "eth_accounts",
      })) as string[];
      if (!accounts.length)
        accounts = (await provider.request({
          method: "eth_requestAccounts",
        })) as string[];
      const from = accounts[0];
      if (!from || !/^0x[a-fA-F0-9]{40}$/.test(from))
        throw new Error("The wallet did not return a valid account.");

      const expectedChain = `0x${chainId.toString(16)}`;
      const currentChain = await provider.request({ method: "eth_chainId" });
      if (currentChain !== expectedChain) {
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: expectedChain }],
        });
      }

      const result = await provider.request({
        method: "eth_sendTransaction",
        params: [
          {
            from,
            to: funding.data.operatorAddress,
            value: `0x${value.toString(16)}`,
          },
        ],
      });
      if (typeof result !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(result)) {
        throw new Error("The wallet did not return a valid transaction hash.");
      }

      setTxHash(result);
      setMessage(
        "Deposit submitted. The gas balance will refresh after confirmation.",
      );
      setState("submitted");
    } catch (error) {
      setMessage(walletErrorMessage(error));
      setState("error");
    }
  };

  return (
    <section
      className="my-4 rounded-2xl border border-primary/25 bg-primary/[0.04] p-4"
      data-testid="quick-deposit-panel"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 font-mono-tight text-[10px] uppercase tracking-[0.08em] text-primary">
            <Fuel size={13} /> Quick gas deposit
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
            This panel selects the route network and its verified operator
            automatically.
          </p>
        </div>
        {funding.data?.ready && !funding.data.paused && (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-accent/10 px-2 py-1 font-mono-tight text-[9px] text-accent">
            <CircleCheck size={11} /> Gas ready
          </span>
        )}
      </div>

      {!executorDeployed ? (
        <div className="mt-3 rounded-xl border border-warning/25 bg-warning/5 p-3 font-mono-tight text-[10px] leading-relaxed text-warning">
          This network is watch-only. Deploy and verify ArbExecutor before
          depositing any funds here.
        </div>
      ) : funding.isLoading ? (
        <div className="mt-3 flex items-center gap-2 font-mono-tight text-[10px] text-muted-foreground">
          <LoaderCircle className="animate-spin" size={13} /> Verifying owner
          and gas balance on-chain…
        </div>
      ) : funding.isError || !funding.data ? (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-warning/25 bg-warning/5 p-3 font-mono-tight text-[10px] text-warning">
          <span>
            Funding is disabled because the operator address could not be
            verified on-chain.
          </span>
          <button
            className="shrink-0 rounded-lg border border-warning/30 p-2"
            onClick={() => void funding.refetch()}
            aria-label="Retry funding check"
          >
            <RefreshCw size={12} />
          </button>
        </div>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-3 gap-2 font-mono-tight text-[9px]">
            <div className="rounded-xl border border-border bg-background/30 p-2.5">
              <span className="text-muted-foreground">Network</span>
              <b className="mt-1 block text-[10px] text-foreground">
                {funding.data.chain}
              </b>
            </div>
            <div className="rounded-xl border border-border bg-background/30 p-2.5">
              <span className="text-muted-foreground">Current gas</span>
              <b className="mt-1 block text-[10px] text-foreground">
                {formatNativeWei(funding.data.balanceWei)}{" "}
                {funding.data.nativeSymbol}
              </b>
            </div>
            <div className="rounded-xl border border-border bg-background/30 p-2.5">
              <span className="text-muted-foreground">Safety minimum</span>
              <b className="mt-1 block text-[10px] text-foreground">
                {formatNativeWei(funding.data.minimumBalanceWei)}{" "}
                {funding.data.nativeSymbol}
              </b>
            </div>
          </div>

          {funding.data.paused && (
            <div className="mt-2 rounded-lg border border-warning/30 bg-warning/5 p-2.5 font-mono-tight text-[10px] text-warning">
              The executor is paused. Funding alone will not make execution
              ready.
            </div>
          )}

          {!funding.data.ready && !funding.data.paused && (
            <div className="mt-2 rounded-lg border border-warning/30 bg-warning/5 p-2.5 font-mono-tight text-[10px] text-warning">
              Gas shortfall: {formatNativeWei(funding.data.shortfallWei)}{" "}
              {funding.data.nativeSymbol}. The suggested amount leaves a 2×
              safety buffer.
            </div>
          )}

          <div className="mt-3 flex items-center gap-2 rounded-xl border border-border bg-background/30 p-2.5">
            <div className="min-w-0 flex-1">
              <span className="block font-mono-tight text-[9px] text-muted-foreground">
                Verified operator · {funding.data.chain}
              </span>
              <code className="mt-1 block truncate text-[10px] text-foreground">
                {funding.data.operatorAddress}
              </code>
            </div>
            <a
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-border text-muted-foreground hover:text-foreground"
              href={`${funding.data.explorerUrl}/address/${funding.data.operatorAddress}`}
              target="_blank"
              rel="noreferrer"
              aria-label="Open operator in block explorer"
            >
              <ExternalLink size={12} />
            </a>
            <button
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-border text-muted-foreground hover:text-foreground"
              onClick={copyOperator}
              aria-label="Copy verified operator address"
              data-testid="button-copy-operator"
            >
              {copied ? <CircleCheck size={12} /> : <Copy size={12} />}
            </button>
          </div>

          <label
            className="mt-3 block font-mono-tight text-[9px] uppercase tracking-[0.06em] text-muted-foreground"
            htmlFor={`deposit-${chainId}`}
          >
            Deposit amount ({funding.data.nativeSymbol})
          </label>
          <div className="mt-1.5 flex gap-2">
            <input
              id={`deposit-${chainId}`}
              className="h-10 min-w-0 flex-1 rounded-xl border border-border bg-background/50 px-3 font-mono-tight text-[11px] outline-none focus:border-primary"
              inputMode="decimal"
              autoComplete="off"
              placeholder={formatNativeWei(funding.data.minimumBalanceWei)}
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                setState("idle");
                setMessage("");
              }}
              data-testid="input-deposit-amount"
            />
            <button
              className="flex h-10 shrink-0 items-center justify-center gap-2 rounded-xl bg-primary px-3 font-mono-tight text-[10px] font-medium text-primary-foreground transition enabled:hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
              onClick={deposit}
              disabled={!amount || funding.data.paused || state === "wallet"}
              data-testid="button-deposit-gas"
            >
              {state === "wallet" ? (
                <LoaderCircle className="animate-spin" size={13} />
              ) : (
                <WalletCards size={13} />
              )}
              {state === "wallet" ? "Check wallet…" : "Deposit gas"}
            </button>
          </div>

          <p className="mt-2 font-mono-tight text-[9px] leading-relaxed text-muted-foreground">
            Native gas only—do not send ERC-20 tokens or flash-loan principal.
            Your wallet shows the exact network, destination, amount, and fee
            before confirmation.
          </p>

          {message && (
            <div
              className={`mt-2 rounded-lg border p-2.5 font-mono-tight text-[10px] ${state === "submitted" ? "border-accent/30 bg-accent/5 text-accent" : "border-warning/30 bg-warning/5 text-warning"}`}
              role="status"
            >
              {message}
              {txHash && (
                <a
                  className="ml-2 inline-flex items-center gap-1 underline"
                  href={`${funding.data.explorerUrl}/tx/${txHash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View transaction <ExternalLink size={10} />
                </a>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
