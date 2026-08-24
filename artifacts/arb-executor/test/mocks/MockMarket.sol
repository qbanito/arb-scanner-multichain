// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

contract MockERC20 is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Stand-in DEX router: pulls `amountIn` of `tokenIn` from the caller and
///         pays out a fixed `amountOut` of `tokenOut`, letting tests set up an
///         arbitrary (profitable or unprofitable) spread deterministically.
contract MockRouter {
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut) external {
        require(IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn), "pull failed");
        require(IERC20(tokenOut).transfer(msg.sender, amountOut), "payout failed");
    }
}
