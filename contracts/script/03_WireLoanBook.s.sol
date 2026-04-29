// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";

import {Common} from "./Common.s.sol";
import {LpVault} from "../src/LpVault.sol";
import {LoanBook} from "../src/LoanBook.sol";

/// @notice Wire the deployed LoanBook into the LpVault: admin proposes,
///         LoanBook (via `acceptLpVaultWiring`) accepts.
/// @dev Idempotent. If `lpVault.loanBook() == loanBook` already, prints
///      `already wired` and exits 0. The admin EOA is derived from
///      `.vanta/dev-seed`; whoever runs this must use that EOA's key as
///      the broadcast principal (DEPLOYER_PRIVATE_KEY = admin private key
///      in the v0 setup — the dev-seed derives both).
contract WireLoanBook is Common {
    string  internal constant CHAIN_LABEL = "local-base-sepolia";
    uint256 internal constant CHAIN_ID = 84532;

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

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        // Admin proposes the LoanBook on the vault.
        if (vault.pendingLoanBook() != loanBookAddr) {
            vault.proposeLoanBook(loanBookAddr);
        }
        // Admin asks the LoanBook to accept (LoanBook contract is the
        // pending principal — only it can call `acceptLoanBook`).
        book.acceptLpVaultWiring();

        vm.stopBroadcast();

        require(vault.loanBook() == loanBookAddr, "wiring failed");
        console2.log("wired LoanBook:", loanBookAddr);
        console2.log("        on vault:", lpVaultAddr);
    }
}
