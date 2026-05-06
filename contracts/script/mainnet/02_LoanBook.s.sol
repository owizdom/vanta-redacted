// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {console2} from "forge-std/console2.sol";

import {Common} from "../Common.s.sol";
import {LpVault} from "../../src/LpVault.sol";
import {LoanBook} from "../../src/LoanBook.sol";

/// @notice Deploy LoanBook on Base mainnet (chain id 8453). Reads LpVault
///         address from deployments/mainnet-base.json (must be present
///         from script 01_LpVault).
contract DeployLoanBookMainnet is Common {
    address public constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    string  internal constant CHAIN_LABEL = "mainnet-base";
    uint256 internal constant CHAIN_ID = 8453;

    error LpVaultNotDeployed();

    function run() external {
        _assertChain(CHAIN_ID);

        address lpVaultAddr = _readAddress(CHAIN_LABEL, "LpVault");
        if (lpVaultAddr == address(0)) revert LpVaultNotDeployed();
        console2.log("using LpVault at:", lpVaultAddr);

        address admin = _deriveAdmin();
        console2.log("derived admin EOA:", admin);

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(deployerKey);
        LoanBook book = new LoanBook(IERC20(USDC), LpVault(lpVaultAddr), admin);
        vm.stopBroadcast();

        console2.log("LoanBook (mainnet) deployed at:", address(book));
        _writeAddress(CHAIN_LABEL, CHAIN_ID, "LoanBook", address(book));
    }
}
