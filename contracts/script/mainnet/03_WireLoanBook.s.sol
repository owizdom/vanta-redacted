// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";

import {Common} from "../Common.s.sol";
import {LpVault} from "../../src/LpVault.sol";
import {LoanBook} from "../../src/LoanBook.sol";

/// @notice Wire the deployed LoanBook into the LpVault on Base mainnet.
contract WireLoanBookMainnet is Common {
    string  internal constant CHAIN_LABEL = "mainnet-base";
    uint256 internal constant CHAIN_ID = 8453;

    error MissingLpVault();
    error MissingLoanBook();

    function run() external {
        _assertChain(CHAIN_ID);

        address lpVaultAddr = _readAddress(CHAIN_LABEL, "LpVault");
        if (lpVaultAddr == address(0)) revert MissingLpVault();
        address loanBookAddr = _readAddress(CHAIN_LABEL, "LoanBook");
        if (loanBookAddr == address(0)) revert MissingLoanBook();

        LpVault vault = LpVault(lpVaultAddr);
        LoanBook book = LoanBook(loanBookAddr);

        if (vault.loanBook() == loanBookAddr) {
            console2.log("already wired:", loanBookAddr);
            return;
        }

        uint256 adminKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(adminKey);

        if (vault.pendingLoanBook() != loanBookAddr) {
            vault.proposeLoanBook(loanBookAddr);
        }
        book.acceptLpVaultWiring();

        vm.stopBroadcast();

        require(vault.loanBook() == loanBookAddr, "wiring failed");
        console2.log("wired LoanBook (mainnet):", loanBookAddr);
        console2.log("                 on vault:", lpVaultAddr);
    }
}
