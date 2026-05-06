// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {console2} from "forge-std/console2.sol";

import {Common} from "../Common.s.sol";
import {LpVault} from "../../src/LpVault.sol";

/// @notice Deploy LpVault on Base mainnet (chain id 8453).
contract DeployLpVaultMainnet is Common {
    address public constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    string  internal constant CHAIN_LABEL = "mainnet-base";
    uint256 internal constant CHAIN_ID = 8453;

    function run() external {
        _assertChain(CHAIN_ID);

        address admin = _deriveAdmin();
        console2.log("derived admin EOA:", admin);

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(deployerKey);
        LpVault vault = new LpVault(IERC20(USDC), admin);
        vm.stopBroadcast();

        console2.log("LpVault (mainnet) deployed at:", address(vault));
        _writeAddress(CHAIN_LABEL, CHAIN_ID, "LpVault", address(vault));
    }
}
