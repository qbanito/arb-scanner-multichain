// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FlashLoanSimpleReceiverBase} from
    "aave-v3-core/contracts/flashloan/base/FlashLoanSimpleReceiverBase.sol";
import {IPoolAddressesProvider} from "aave-v3-core/contracts/interfaces/IPoolAddressesProvider.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {Pausable} from "openzeppelin-contracts/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";

/// @title ArbExecutor
/// @notice Captures multi-leg DEX arbitrage using an Aave V3 flash loan. The owner
///         (an off-chain scanner/backend) supplies the exact calldata for each swap
///         leg; the contract enforces that every call target is pre-approved,
///         that the flash loan is fully repaid, and that a minimum net profit is met
///         before any state change is kept.
/// @dev This contract is UNAUDITED. Do not deposit funds beyond what you are willing
///      to lose, and do not point it at real capital before an independent security
///      review. See README.md in this package for the pre-mainnet checklist.
contract ArbExecutor is FlashLoanSimpleReceiverBase, Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice One leg of an arbitrage route: a raw call to an allow-listed target.
    struct Leg {
        address target;
        bytes data;
    }

    /// @notice Parameters for a single arbitrage attempt, ABI-encoded into the
    ///         flash loan `params` and decoded again in `executeOperation`.
    struct ArbParams {
        Leg[] legs;
        uint256 minProfit;
        address profitToken;
    }

    /// @notice Contracts the owner has approved as flash-loan-leg call targets
    ///         (DEX routers, and the borrowed/output token contracts themselves
    ///         for `approve` calls). Every `Leg.target` must be in this set.
    mapping(address => bool) public allowedTargets;

    event TargetAllowed(address indexed target, bool allowed);
    event ArbitrageExecuted(
        address indexed asset, uint256 amount, uint256 premium, uint256 netProfit, address indexed profitToken
    );
    event ProfitWithdrawn(address indexed token, address indexed to, uint256 amount);
    event Rescued(address indexed token, address indexed to, uint256 amount);

    error TargetNotAllowed(address target);
    error LegCallFailed(uint256 legIndex, bytes returndata);
    error InsufficientRepayment(uint256 owed, uint256 balance);
    error ProfitBelowMinimum(uint256 actual, uint256 required);
    error UntrustedInitiator(address initiator);
    error UntrustedCaller(address caller);
    error NoLegs();

    constructor(address addressesProvider, address initialOwner)
        FlashLoanSimpleReceiverBase(IPoolAddressesProvider(addressesProvider))
        Ownable(initialOwner)
    {}

    /// @notice Add or remove an address from the call-target allow-list.
    /// @dev Only the owner can extend the attack surface of `executeOperation`.
    function setAllowedTarget(address target, bool allowed) external onlyOwner {
        allowedTargets[target] = allowed;
        emit TargetAllowed(target, allowed);
    }

    /// @notice Pause new arbitrage attempts without revoking allow-listed targets.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Borrow `amount` of `asset` from Aave V3 and run the supplied legs.
    /// @param asset The token to flash-borrow (must be the token the first leg spends).
    /// @param amount The amount to borrow.
    /// @param legs The ordered calls that perform the two (or more) swap hops.
    /// @param minProfit The minimum acceptable profit in `profitToken`; the whole
    ///        transaction reverts if the route nets less, so a stale or front-run
    ///        opportunity costs only gas, never principal.
    /// @param profitToken The token profit is measured and left in the contract in
    ///        (normally the same as `asset`).
    function initiateArbitrage(address asset, uint256 amount, Leg[] calldata legs, uint256 minProfit, address profitToken)
        external
        onlyOwner
        whenNotPaused
        nonReentrant
    {
        if (legs.length == 0) revert NoLegs();
        for (uint256 i = 0; i < legs.length; i++) {
            if (!allowedTargets[legs[i].target]) revert TargetNotAllowed(legs[i].target);
        }

        bytes memory params = abi.encode(ArbParams({legs: legs, minProfit: minProfit, profitToken: profitToken}));
        POOL.flashLoanSimple(address(this), asset, amount, params, 0);
    }

    /// @notice Aave V3 flash loan callback. Runs the arb legs, repays the loan
    ///         plus premium, and enforces the minimum profit floor.
    /// @dev No `nonReentrant` here: this is Aave's own synchronous callback into
    ///      `initiateArbitrage`'s call stack, which already holds the reentrancy
    ///      lock for the whole flash-loan lifecycle. Access is instead restricted
    ///      to `POOL` calling back on a loan `this` contract itself initiated.
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external
        override
        returns (bool)
    {
        if (msg.sender != address(POOL)) revert UntrustedCaller(msg.sender);
        if (initiator != address(this)) revert UntrustedInitiator(initiator);

        ArbParams memory arb = abi.decode(params, (ArbParams));

        for (uint256 i = 0; i < arb.legs.length; i++) {
            Leg memory leg = arb.legs[i];
            if (!allowedTargets[leg.target]) revert TargetNotAllowed(leg.target);
            (bool ok, bytes memory ret) = leg.target.call(leg.data);
            if (!ok) revert LegCallFailed(i, ret);
        }

        uint256 owed = amount + premium;
        uint256 assetBalance = IERC20(asset).balanceOf(address(this));
        if (assetBalance < owed) revert InsufficientRepayment(owed, assetBalance);

        uint256 profitBalance = IERC20(arb.profitToken).balanceOf(address(this));
        uint256 netProfit = arb.profitToken == asset ? assetBalance - owed : profitBalance;
        if (netProfit < arb.minProfit) revert ProfitBelowMinimum(netProfit, arb.minProfit);

        IERC20(asset).forceApprove(address(POOL), owed);

        emit ArbitrageExecuted(asset, amount, premium, netProfit, arb.profitToken);
        return true;
    }

    /// @notice Sweep accumulated profit (or any ERC-20) to the owner.
    function withdrawToken(address token, address to, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
        emit ProfitWithdrawn(token, to, amount);
    }

    /// @notice Sweep native ETH accidentally sent to the contract.
    function withdrawETH(address payable to, uint256 amount) external onlyOwner {
        (bool ok,) = to.call{value: amount}("");
        require(ok, "ETH transfer failed");
        emit Rescued(address(0), to, amount);
    }

    /// @notice Escape hatch for tokens stuck in the contract outside of an
    ///         in-flight flash loan (e.g. sent here by mistake).
    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
        emit Rescued(token, to, amount);
    }

    receive() external payable {}
}
