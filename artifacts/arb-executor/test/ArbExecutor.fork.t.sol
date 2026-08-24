// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ArbExecutor} from "../src/ArbExecutor.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

/// @notice Integration test against the REAL Aave V3 deployment on Arbitrum.
///         Requires ARBITRUM_RPC_URL to be set; otherwise every test is a no-op
///         pass so `forge test` still works without network access.
///
///         This only proves the flash-loan wiring (provider address, pool
///         lookup, premium accounting, callback selector) matches Aave's real
///         contracts — it does not exercise real DEX swap legs. Swap-leg logic
///         is covered by the mock-based suite in ArbExecutor.t.sol.
///
///         Run with: ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc forge test --match-path '*fork*' -vv
contract ArbExecutorForkTest is Test {
    // Aave V3 Arbitrum PoolAddressesProvider, verified against bgd-labs/aave-address-book
    // (AaveV3Arbitrum.POOL_ADDRESSES_PROVIDER): https://arbiscan.io/address/0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb
    address constant AAVE_POOL_ADDRESSES_PROVIDER = 0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb;
    // Native USDC on Arbitrum One (matches artifacts/api-server/src/routes/scanner.ts TOKEN_DEFINITIONS)
    address constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;

    address owner = makeAddr("owner");
    ArbExecutor executor;
    bool forkAvailable;

    function setUp() public {
        string memory rpcUrl = vm.envOr("ARBITRUM_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) {
            forkAvailable = false;
            return;
        }
        vm.createSelectFork(rpcUrl);
        forkAvailable = true;

        executor = new ArbExecutor(AAVE_POOL_ADDRESSES_PROVIDER, owner);
        vm.prank(owner);
        executor.setAllowedTarget(USDC, true);
    }

    function test_RealAaveFlashLoanBorrowsAndRepays() public {
        if (!forkAvailable) {
            emit log("skipped: set ARBITRUM_RPC_URL to run this fork test");
            return;
        }

        uint256 borrow = 10_000e6; // 10k USDC
        // No real swap here — pre-fund the contract so it can cover principal +
        // Aave's premium, isolating "does the real flash loan round-trip work"
        // from "does the swap route work" (already covered by the mock suite).
        deal(USDC, address(executor), (borrow * 101) / 100);

        // A genuinely harmless leg (a view call) — the point of this test is to
        // exercise the real Aave borrow/callback/repay round trip, not a swap.
        ArbExecutor.Leg[] memory legs = new ArbExecutor.Leg[](1);
        legs[0] =
            ArbExecutor.Leg({target: USDC, data: abi.encodeCall(IERC20.balanceOf, (address(executor)))});

        uint256 balanceBefore = IERC20(USDC).balanceOf(address(executor));

        vm.prank(owner);
        executor.initiateArbitrage(USDC, borrow, legs, 0, USDC);

        uint256 balanceAfter = IERC20(USDC).balanceOf(address(executor));
        assertLt(balanceAfter, balanceBefore, "premium should have been paid to Aave");
    }
}
