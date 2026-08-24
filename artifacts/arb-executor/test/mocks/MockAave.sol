// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

interface IFlashLoanSimpleReceiverLike {
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external
        returns (bool);
}

/// @notice Minimal stand-in for the Aave V3 Pool's flashLoanSimple flow, just
///         enough to unit test ArbExecutor without forking mainnet: sends the
///         borrowed amount, invokes the callback, then pulls back principal + fee.
contract MockPool {
    uint256 public constant PREMIUM_BPS = 5; // 0.05%, matches Aave V3 default

    function flashLoanSimple(address receiverAddress, address asset, uint256 amount, bytes calldata params, uint16)
        external
    {
        uint256 premium = (amount * PREMIUM_BPS) / 10_000;
        IERC20(asset).transfer(receiverAddress, amount);
        bool ok = IFlashLoanSimpleReceiverLike(receiverAddress).executeOperation(
            asset, amount, premium, msg.sender, params
        );
        require(ok, "MockPool: op failed");
        bool pulled = IERC20(asset).transferFrom(receiverAddress, address(this), amount + premium);
        require(pulled, "MockPool: repayment pull failed");
    }
}

/// @notice Minimal stand-in for Aave's PoolAddressesProvider — only `getPool()`
///         is ever called by FlashLoanSimpleReceiverBase's constructor.
contract MockAddressesProvider {
    address public pool;

    constructor(address _pool) {
        pool = _pool;
    }

    function getPool() external view returns (address) {
        return pool;
    }
}
