// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ArbExecutor} from "../src/ArbExecutor.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

/// @notice Verifies the executor against the live Aave V3 BNB Chain market.
///         The provider and reserve addresses are sourced from the current
///         aave-dao/aave-address-book AaveV3BNB deployment.
contract ArbExecutorBnbForkTest is Test {
    address constant AAVE_POOL_ADDRESSES_PROVIDER = 0xff75B6da14FfbbfD355Daf7a2731456b3562Ba6D;
    address constant USDC = 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d;

    address owner = makeAddr("bnb-owner");
    ArbExecutor executor;
    bool forkAvailable;

    function setUp() public {
        string memory rpcUrl = vm.envOr("BSC_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) return;

        vm.createSelectFork(rpcUrl);
        forkAvailable = true;
        executor = new ArbExecutor(AAVE_POOL_ADDRESSES_PROVIDER, owner);
        vm.prank(owner);
        executor.setAllowedTarget(USDC, true);
    }

    function test_RealAaveBnbFlashLoanBorrowsAndRepays() public {
        if (!forkAvailable) {
            emit log("skipped: set BSC_RPC_URL to run the BNB Chain fork test");
            return;
        }

        uint256 borrow = 1_000e18;
        deal(USDC, address(executor), (borrow * 101) / 100);

        ArbExecutor.Leg[] memory legs = new ArbExecutor.Leg[](1);
        legs[0] = ArbExecutor.Leg({
            target: USDC,
            data: abi.encodeCall(IERC20.balanceOf, (address(executor)))
        });

        uint256 balanceBefore = IERC20(USDC).balanceOf(address(executor));
        vm.prank(owner);
        executor.initiateArbitrage(USDC, borrow, legs, 0, USDC);
        assertLt(IERC20(USDC).balanceOf(address(executor)), balanceBefore, "premium should be paid to Aave");
    }
}
