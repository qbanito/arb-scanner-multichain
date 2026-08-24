// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ArbExecutor} from "../src/ArbExecutor.sol";
import {MockPool, MockAddressesProvider} from "./mocks/MockAave.sol";
import {MockERC20, MockRouter} from "./mocks/MockMarket.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

contract ArbExecutorTest is Test {
    ArbExecutor executor;
    MockPool pool;
    MockAddressesProvider provider;
    MockERC20 usdc;
    MockERC20 weth;
    MockRouter buyRouter;
    MockRouter sellRouter;

    address owner = makeAddr("owner");
    address attacker = makeAddr("attacker");

    uint256 constant BORROW = 100_000e6; // 100k USDC (6 decimals)

    function setUp() public {
        pool = new MockPool();
        provider = new MockAddressesProvider(address(pool));
        executor = new ArbExecutor(address(provider), owner);

        usdc = new MockERC20("USD Coin", "USDC");
        weth = new MockERC20("Wrapped Ether", "WETH");
        buyRouter = new MockRouter();
        sellRouter = new MockRouter();

        // Fund the flash loan pool with liquidity to lend out.
        usdc.mint(address(pool), 10_000_000e6);
        // Fund routers so they can pay out the swap legs.
        weth.mint(address(buyRouter), 1_000e18);
        usdc.mint(address(sellRouter), 10_000_000e6);

        vm.startPrank(owner);
        executor.setAllowedTarget(address(usdc), true);
        executor.setAllowedTarget(address(weth), true);
        executor.setAllowedTarget(address(buyRouter), true);
        executor.setAllowedTarget(address(sellRouter), true);
        vm.stopPrank();
    }

    /// @dev Builds a profitable two-leg route: BORROW USDC -> WETH (buyRouter)
    ///      -> back to USDC (sellRouter) for BORROW + `profit`.
    function _profitableLegs(uint256 amountIn, uint256 wethOut, uint256 usdcOut)
        internal
        view
        returns (ArbExecutor.Leg[] memory legs)
    {
        legs = new ArbExecutor.Leg[](4);
        legs[0] = ArbExecutor.Leg({
            target: address(usdc),
            data: abi.encodeCall(IERC20.approve, (address(buyRouter), amountIn))
        });
        legs[1] = ArbExecutor.Leg({
            target: address(buyRouter),
            data: abi.encodeCall(MockRouter.swap, (address(usdc), address(weth), amountIn, wethOut))
        });
        legs[2] = ArbExecutor.Leg({
            target: address(weth),
            data: abi.encodeCall(IERC20.approve, (address(sellRouter), wethOut))
        });
        legs[3] = ArbExecutor.Leg({
            target: address(sellRouter),
            data: abi.encodeCall(MockRouter.swap, (address(weth), address(usdc), wethOut, usdcOut))
        });
    }

    function test_ProfitableArbitrageRepaysAndKeepsProfit() public {
        uint256 premium = (BORROW * pool.PREMIUM_BPS()) / 10_000;
        uint256 usdcOut = BORROW + premium + 500e6; // 500 USDC profit after fees

        ArbExecutor.Leg[] memory legs = _profitableLegs(BORROW, 40e18, usdcOut);

        vm.prank(owner);
        executor.initiateArbitrage(address(usdc), BORROW, legs, 400e6, address(usdc));

        assertEq(usdc.balanceOf(address(executor)), 500e6, "profit should remain in contract");

        vm.prank(owner);
        executor.withdrawToken(address(usdc), owner, 500e6);
        assertEq(usdc.balanceOf(owner), 500e6);
    }

    function test_RevertsWhenProfitBelowMinimum() public {
        uint256 premium = (BORROW * pool.PREMIUM_BPS()) / 10_000;
        uint256 usdcOut = BORROW + premium + 10e6; // only 10 USDC profit

        ArbExecutor.Leg[] memory legs = _profitableLegs(BORROW, 40e18, usdcOut);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ArbExecutor.ProfitBelowMinimum.selector, 10e6, 500e6));
        executor.initiateArbitrage(address(usdc), BORROW, legs, 500e6, address(usdc));
    }

    function test_RevertsWhenRouteCannotRepayLoan() public {
        uint256 usdcOut = BORROW - 1_000e6; // route loses money, can't cover principal + fee

        ArbExecutor.Leg[] memory legs = _profitableLegs(BORROW, 40e18, usdcOut);

        vm.prank(owner);
        vm.expectRevert();
        executor.initiateArbitrage(address(usdc), BORROW, legs, 0, address(usdc));
    }

    function test_RevertsWhenTargetNotAllowlisted() public {
        MockRouter roguerRouter = new MockRouter();
        ArbExecutor.Leg[] memory legs = new ArbExecutor.Leg[](1);
        legs[0] = ArbExecutor.Leg({
            target: address(roguerRouter),
            data: abi.encodeCall(MockRouter.swap, (address(usdc), address(weth), BORROW, 1))
        });

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ArbExecutor.TargetNotAllowed.selector, address(roguerRouter)));
        executor.initiateArbitrage(address(usdc), BORROW, legs, 0, address(usdc));
    }

    function test_RevertsWhenNonOwnerInitiates() public {
        ArbExecutor.Leg[] memory legs = _profitableLegs(BORROW, 40e18, BORROW);

        vm.prank(attacker);
        vm.expectRevert();
        executor.initiateArbitrage(address(usdc), BORROW, legs, 0, address(usdc));
    }

    function test_RevertsWhenPaused() public {
        ArbExecutor.Leg[] memory legs = _profitableLegs(BORROW, 40e18, BORROW);

        vm.prank(owner);
        executor.pause();

        vm.prank(owner);
        vm.expectRevert();
        executor.initiateArbitrage(address(usdc), BORROW, legs, 0, address(usdc));
    }

    function test_ExecuteOperationRejectsDirectCall() public {
        ArbExecutor.Leg[] memory legs = _profitableLegs(BORROW, 40e18, BORROW);
        bytes memory params = abi.encode(ArbExecutor.ArbParams({legs: legs, minProfit: 0, profitToken: address(usdc)}));

        vm.expectRevert(abi.encodeWithSelector(ArbExecutor.UntrustedCaller.selector, address(this)));
        executor.executeOperation(address(usdc), BORROW, 0, address(executor), params);
    }

    function test_NonOwnerCannotAllowlistTargets() public {
        vm.prank(attacker);
        vm.expectRevert();
        executor.setAllowedTarget(address(attacker), true);
    }

    function test_NonOwnerCannotWithdraw() public {
        vm.prank(attacker);
        vm.expectRevert();
        executor.withdrawToken(address(usdc), attacker, 1);
    }

    function test_OwnerCanRescueStrayTokens() public {
        usdc.mint(address(executor), 100e6);

        vm.prank(owner);
        executor.rescueToken(address(usdc), owner, 100e6);
        assertEq(usdc.balanceOf(owner), 100e6);
    }
}
