# arb-executor

A Foundry package that executes the closed, same-chain DEX cycles the
[scanner](../arb-scanner) detects. Routes may contain two to four swaps and
use an Aave V3 flash loan, so no trading principal is locked between scans.

**Status: unaudited. Do not point this at real capital yet.** See
[Before mainnet, with real capital](#before-mainnet-with-real-capital) below.

## How it works

`src/ArbExecutor.sol` is a single contract:

1. The owner (your backend/bot key) calls `initiateArbitrage(asset, amount, legs, minProfit, profitToken)`.
2. The contract borrows `amount` of `asset` from Aave V3 via `flashLoanSimple`.
3. In the `executeOperation` callback, it runs `legs` — an ordered list of raw
   `(target, calldata)` calls, e.g. `USDC.approve(router, x)` then
   `router.swap(...)`, then the same for the sell leg back to `asset`.
4. It checks the contract holds enough `asset` to repay principal + Aave's
   premium, and that the leftover `profitToken` balance is at least
   `minProfit` — otherwise the **entire transaction reverts**, so a stale or
   front-run opportunity only costs gas, never principal.
5. Profit sits in the contract until the owner calls `withdrawToken`.

Every `Leg.target` must be pre-approved via `setAllowedTarget` (owner-only).
This is the main blast-radius control: even if the off-chain route-builder has
a bug or is compromised, `executeOperation` can only ever call contracts you
explicitly allow-listed (DEX routers and the specific token contracts), never
an arbitrary address.

## Why generic calldata legs

The scanner reports opportunities across many `dexId`s (Uniswap V2/V3,
Sushi, Camelot, etc. — see `TOKEN_DEFINITIONS` and the route graph in
[`artifacts/api-server/src/routes/scanner.ts`](../api-server/src/routes/scanner.ts)).
Hardcoding router ABIs for each one would mean re-shipping the contract every
time a new venue shows up. Instead, [`executor-bot`](../executor-bot) builds
the exact `Leg[]` calldata, re-quotes every hop on-chain, checks allow-listed
targets and gas-adjusted profit, and simulates the complete transaction before
live submission. Unknown venues are rejected rather than guessed.

## Build & test

```bash
forge build
forge test                                      # 10 mock-based unit tests, no network needed
ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc \
  forge test --match-path '*fork*' -vv          # real Aave V3 Arbitrum integration test
```

The fork test borrows real USDC from the real Aave V3 pool on a local fork,
proving the `PoolAddressesProvider`/`Pool`/premium/callback wiring is correct
against live infrastructure — not just mocks. It does not exercise a real DEX
swap leg (that's covered by the mock suite in `test/ArbExecutor.t.sol`, which
tests profit accounting, the allow-list, access control, pause, and
repayment-shortfall handling).

## Deploy

Copy `.env.example` to `.env` and fill in the real values **in your editor**
— `.env` is already git-ignored, and nothing in this workflow should ever
have you paste a private key into a chat, issue, or log. Forge auto-loads
`.env` from the project directory, so once it's filled in:

The deployment script is chain-independent. Set the RPC and Aave V3
`POOL_ADDRESSES_PROVIDER` for the target chain, then run it with an encrypted
Foundry account or hardware signer. Provider addresses are chain-specific;
verify the target network against Aave's current official address book
immediately before every deployment.

```bash
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$TARGET_RPC_URL" \
  --account arb-deployer \
  --broadcast --verify
```

`ALLOWED_TARGETS` must contain every ERC-20 and router/pool called by the
routes on that deployment. After deployment, configure the resulting address
as `ARB_EXECUTOR_ETHEREUM`, `ARB_EXECUTOR_ARBITRUM`,
the matching `ARB_EXECUTOR_<NETWORK>` variable in both the API and bot.

Use a wallet dedicated to deploying/operating this contract, funded only
with what it needs for gas — never your main MetaMask account. A leaked
deploy key costs you gas money; a leaked main-wallet key costs you
everything else in that wallet too. For anything beyond initial testing,
prefer `cast wallet import` (Foundry's encrypted keystore, unlocked with a
password via `--account` instead of a plaintext `--private-key`) over
keeping a raw key in `.env` at all.

Never put `PRIVATE_KEY` in a committed file or `.env` tracked by git — use
your shell environment, a secrets manager, or `cast wallet` / a hardware
signer. Prefer `--ledger`/`--trezor` or a multisig owner over a raw hot-wallet
private key for anything holding real funds.

## Before mainnet, with real capital

This contract has **not** been professionally audited. It has 10 unit tests
and one real-network integration test — that proves the mechanics work, not
that the contract is safe against a motivated attacker. Concretely, before
routing real capital through it:

1. **Get an independent security review.** Flash-loan arbitrage contracts are
   a well-understood pattern, but the specific allow-list, calldata, and
   profit-accounting logic here is new code and deserves a second set of
   eyes — ideally a paid audit (even a lightweight one) given it will hold
   and move borrowed funds.
2. **Run it on a testnet or fork with real bot infrastructure first** — use
   the actual route builder and RPC infrastructure, and let it run
   dry (simulate-only, `--broadcast` off) against live opportunities for a
   while before sending real transactions.
3. **Start with a tiny `amount` and a generous `minProfit`** on the first
   live mainnet transactions, and watch them individually before automating.
4. **Use a multisig as `owner`**, not a single hot-wallet key, once you're
   past initial testing — a compromised owner key can drain accumulated
   profit and, while it can't move the allow-list past what you configured,
   it can still submit unprofitable or resource-wasting transactions.
5. **Understand MEV competition.** Public mempool transactions calling
   `initiateArbitrage` are visible to searchers who can front-run or
   sandwich them. For anything beyond small/testing amounts, submit through
   a private orderflow route (e.g. Flashbots Protect equivalents on
   Arbitrum, or a sequencer-level private RPC) rather than the public
   mempool.
6. **Reconcile gas assumptions.** The scanner's off-chain profit estimate
   uses simplified fee/gas assumptions (see `scanner.ts`); this contract's
   `minProfit` check is the real backstop, but size it to comfortably cover
   actual on-chain gas at execution time, not the scanner's estimate.

## Off-chain execution service

[`executor-bot`](../executor-bot) is the corresponding off-chain service. It
consumes scanner opportunities and manual execution requests, supports
explicit closed cycles up to four swaps, tries multiple borrow sizes, builds
calldata only for verified DEX adapters, reads the Aave premium, checks the
contract allow-list, estimates real gas, applies the configured profit-over-gas
floor, and simulates `initiateArbitrage` before any transaction is sent.

`ENABLE_LIVE_EXECUTION=false` remains the default. A green scanner card is a
candidate; only a successful last-block quote and full contract simulation is
an executable order. No software can guarantee that an arbitrage remains
profitable between simulation and inclusion.
