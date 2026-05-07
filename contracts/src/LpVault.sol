// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20, IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {ILoanBook} from "./interfaces/ILoanBook.sol";

/// @title LpVault — VANTA LP USDC vault (ERC-4626).
/// @notice Single-asset vault that holds idle USDC + reports outstanding
///         principal lent through the LoanBook. Shares are vLP.
/// @dev Invariants:
///        - I-LP-1: `totalAssets()` = idle USDC balance + LoanBook
///                  `outstandingPrincipal()` (when wired).
///        - I-LP-2: asset is immutable for the lifetime of the vault —
///                  set at construction, enforced by ERC4626's
///                  `_asset` immutable. Deploy script is responsible
///                  for passing the correct USDC for the target chain
///                  (Sepolia 0x036C…CF7e, Base mainnet 0x8335…2913).
///        - I-LP-3: `_decimalsOffset() == 6` — virtual shares neutralise the
///                  classic ERC-4626 inflation attack.
contract LpVault is ERC4626, Ownable2Step {
    using SafeERC20 for IERC20;

    /// @notice Currently-wired LoanBook. `address(0)` while unwired.
    address public loanBook;

    /// @notice Pending LoanBook awaiting `acceptLoanBook` from the next
    ///         contract. Cleared on accept or on a fresh proposal.
    address public pendingLoanBook;

    error NotPendingLoanBook(address sender);
    error PendingLoanBookUnset();
    error NotLoanBook(address sender);
    error LoanBookUnset();

    event LoanBookProposed(address indexed pending);
    event LoanBookAccepted(address indexed loanBook);
    event Drawn(address indexed to, uint256 amount);

    /// @param asset_ The USDC contract for the deploy chain. Stored as
    ///               immutable by ERC4626; cannot be changed post-deploy.
    /// @param admin_ Initial owner. Subject to `Ownable2Step` rotation rules.
    constructor(IERC20 asset_, address admin_)
        ERC20("VANTA LP", "vLP")
        ERC4626(asset_)
        Ownable(admin_)
    {}

    // -----------------------------------------------------------------------
    // ERC-4626 overrides
    // -----------------------------------------------------------------------

    /// @inheritdoc ERC4626
    /// @dev I-LP-3. With underlying decimals = 6 and offset 6, virtual shares
    ///      are scaled by 10**12 against virtual assets — first-depositor
    ///      donation attacks become economically uninteresting.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    /// @inheritdoc ERC4626
    /// @dev I-LP-1. Total assets = held USDC + outstanding principal under
    ///      the LoanBook. Pre-wire the contract reports only the held
    ///      balance, which is the safe pre-LoanBook accounting universe.
    function totalAssets() public view override returns (uint256) {
        uint256 bal = IERC20(asset()).balanceOf(address(this));
        if (loanBook == address(0)) return bal;
        return bal + ILoanBook(loanBook).outstandingPrincipal();
    }

    // -----------------------------------------------------------------------
    // Two-step LoanBook wiring
    // -----------------------------------------------------------------------

    /// @notice Propose a LoanBook. Owner-only. Caller does not need to be the
    ///         next LoanBook itself; the next LoanBook accepts in a follow-up.
    function proposeLoanBook(address next) external onlyOwner {
        pendingLoanBook = next;
        emit LoanBookProposed(next);
    }

    /// @notice The pending LoanBook accepts the proposal, becoming the live
    ///         LoanBook. Anything else reverts.
    function acceptLoanBook() external {
        address pending = pendingLoanBook;
        if (pending == address(0)) revert PendingLoanBookUnset();
        if (msg.sender != pending) revert NotPendingLoanBook(msg.sender);
        loanBook = pending;
        pendingLoanBook = address(0);
        emit LoanBookAccepted(pending);
    }

    // -----------------------------------------------------------------------
    // LoanBook draw path
    // -----------------------------------------------------------------------

    /// @notice Move USDC out of the vault to a borrower at the LoanBook's
    ///         direction. The LoanBook is the only authorised caller.
    /// @dev We do not use approve+transferFrom because it widens the trust
    ///      surface of the vault (anyone with a stale allowance becomes a
    ///      withdraw vector). Instead the LoanBook calls `drawFor` and the
    ///      vault internally executes a `safeTransfer`.
    function drawFor(address to, uint256 amount) external {
        if (loanBook == address(0)) revert LoanBookUnset();
        if (msg.sender != loanBook) revert NotLoanBook(msg.sender);
        IERC20(asset()).safeTransfer(to, amount);
        emit Drawn(to, amount);
    }
}
