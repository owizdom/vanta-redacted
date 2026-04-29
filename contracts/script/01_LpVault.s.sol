// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {console2} from "forge-std/console2.sol";

import {Common} from "./Common.s.sol";
import {LpVault} from "../src/LpVault.sol";

/// @notice Deploy LpVault on Base Sepolia.
/// @dev Reads the dev-time seed at `.vanta/dev-seed` (root-relative), derives
///      the origination admin EOA via HKDF-SHA256 with info string
///      `"vanta-origination-eoa"`, and deploys with that EOA as the
///      Ownable2Step admin.
contract DeployLpVault is Common {
    address public constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    string  internal constant CHAIN_LABEL = "local-base-sepolia";
    uint256 internal constant CHAIN_ID = 84532;

    function run() external {
        _assertChain(CHAIN_ID);

        address admin = _deriveAdmin();
        console2.log("derived admin EOA:", admin);

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(deployerKey);
        LpVault vault = new LpVault(IERC20(USDC), admin);
        vm.stopBroadcast();

        console2.log("LpVault deployed at:", address(vault));
        _writeAddress(CHAIN_LABEL, CHAIN_ID, "LpVault", address(vault));
    }
}
