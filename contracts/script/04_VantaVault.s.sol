// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {console2} from "forge-std/console2.sol";

import {Common} from "./Common.s.sol";
import {VantaVault} from "../src/VantaVault.sol";

/// @notice Deploy VantaVault on Polygon Amoy. The vault is pinned to the
///         Polymarket ConditionalTokens (CTF) ERC-1155 contract; admin is
///         the same dev-seed-derived EOA used by the Base Sepolia stack.
contract DeployVantaVault is Common {
    /// @dev Polymarket ConditionalTokens on Amoy. Mirrors
    ///      `venue-poly/src/constants.ts::CTF_ADDRESS`.
    address public constant CTF = 0x69308FB512518e39F9b16112fA8d994F4e2Bf8bB;
    string  internal constant CHAIN_LABEL = "local-amoy";
    uint256 internal constant CHAIN_ID = 80002;

    function run() external {
        _assertChain(CHAIN_ID);

        address admin = _deriveAdmin();
        console2.log("derived admin EOA:", admin);

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(deployerKey);
        VantaVault vault = new VantaVault(IERC1155(CTF), admin);
        vm.stopBroadcast();

        console2.log("VantaVault deployed at:", address(vault));
        _writeAddress(CHAIN_LABEL, CHAIN_ID, "VantaVault", address(vault));
    }
}
