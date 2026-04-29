// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal LoanBook surface used by `LpVault.totalAssets()`.
/// @dev Kept deliberately tiny so the vault never becomes coupled to the
///      LoanBook implementation. Anything richer belongs on the LoanBook
///      contract or its events.
interface ILoanBook {
    /// @return Total USDC principal currently lent out, in 6-decimal wei.
    function outstandingPrincipal() external view returns (uint256);
}
