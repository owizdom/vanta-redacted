// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {console2} from "forge-std/console2.sol";

import {Common} from "./Common.s.sol";
import {LpVault} from "../src/LpVault.sol";
import {LoanBook} from "../src/LoanBook.sol";

/// @notice Deploy LoanBook on Base Sepolia and stamp the address into
///         deployments/local-base-sepolia.json. Reads the LpVault
///         address from the same file (must be present from script 01).
/// @dev    Bumped on settle-primitives change (markRepaid pull,
///         markLiquidated(loanId, auctionEscrow, proceeds)) — re-run to
///         pick up the new bytecode.
contract DeployLoanBook is Common {
    address public constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    string  internal constant CHAIN_LABEL = "local-base-sepolia";
    uint256 internal constant CHAIN_ID = 84532;

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

        console2.log("LoanBook deployed at:", address(book));
        _writeAddress(CHAIN_LABEL, CHAIN_ID, "LoanBook", address(book));
    }
}
