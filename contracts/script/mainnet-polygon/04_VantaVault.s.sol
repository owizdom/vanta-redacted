// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {console2} from "forge-std/console2.sol";

import {Common} from "../Common.s.sol";
import {VantaVault} from "../../src/VantaVault.sol";

/// @notice Deploy VantaVault on Polygon mainnet (chain id 137).
/// @dev Mirrors `script/04_VantaVault.s.sol` but pinned to mainnet
///      Polymarket. Verify CTF address against Polygonscan before
///      broadcast — Polymarket's canonical ConditionalTokens
///      deployment on Polygon mainnet is the well-known address
///      below. Admin is the same seed-derived EOA used for the
///      Base mainnet stack (see Common._deriveAdmin).
contract DeployVantaVaultMainnet is Common {
    /// @dev Polymarket ConditionalTokens (ERC-1155) on Polygon mainnet.
    ///      Canonical Polymarket deployment; verify on polygonscan.com
    ///      against `supportsInterface(0xd9b67a26) === true` before
    ///      broadcast.
    address public constant CTF = 0x4D97DCd97eC945f40cF65F87097ACe5EA0476045;
    string  internal constant CHAIN_LABEL = "mainnet-polygon";
    uint256 internal constant CHAIN_ID = 137;

    function run() external {
        _assertChain(CHAIN_ID);

        address admin = _deriveAdmin();
        console2.log("derived admin EOA:", admin);

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(deployerKey);
        VantaVault vault = new VantaVault(IERC1155(CTF), admin);
        vm.stopBroadcast();

        console2.log("VantaVault (mainnet-polygon) deployed at:", address(vault));
        _writeAddress(CHAIN_LABEL, CHAIN_ID, "VantaVault", address(vault));
    }
}
