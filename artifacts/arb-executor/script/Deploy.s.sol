// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ArbExecutor} from "../src/ArbExecutor.sol";

/// @notice Deploys ArbExecutor and wires up the flash-loan asset plus DEX
///         routers as allow-listed call targets. Configure via env vars —
///         see README.md for the full pre-flight checklist.
///
/// Usage (testnet/mainnet — set PRIVATE_KEY, POOL_ADDRESSES_PROVIDER, OWNER,
/// and a comma-free ALLOWED_TARGETS list in your shell/CI secrets, never in a
/// committed file):
///   forge script script/Deploy.s.sol:Deploy \
///     --rpc-url $ARBITRUM_RPC_URL \
///     --broadcast --verify -vvvv
contract Deploy is Script {
    function run() external returns (ArbExecutor executor) {
        address addressesProvider = vm.envAddress("POOL_ADDRESSES_PROVIDER");
        address owner = vm.envOr("OWNER", msg.sender);
        address[] memory targets = vm.envOr("ALLOWED_TARGETS", ",", new address[](0));

        vm.startBroadcast();
        executor = new ArbExecutor(addressesProvider, owner);
        for (uint256 i = 0; i < targets.length; i++) {
            executor.setAllowedTarget(targets[i], true);
        }
        vm.stopBroadcast();

        console.log("ArbExecutor deployed at:", address(executor));
        console.log("Owner:", owner);
        console.log("Allowed targets configured:", targets.length);
    }
}
