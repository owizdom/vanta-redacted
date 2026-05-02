// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {LpVault} from "./LpVault.sol";

/// @title LoanBook — VANTA loan state machine.
/// @notice One-loan-per-id state machine: None → Active → {Repaid,
///         Liquidated}. Owner-only (the enclave-derived origination EOA)
///         drives every transition; the on-chain contract has no policy of
///         its own. Funds flow through the wired `LpVault.drawFor` path.
/// @dev Invariants:
///        - I-LB-3: no reverse transitions. Once Repaid or Liquidated, a
///          loanId is terminal.
///        - I-LB-5: paramsHash binds (borrower, principal, haircutBps,
///          maturityTs) — anyone reading an Originated event can verify
///          the chain entry matches the off-chain origination spec.
contract LoanBook is Ownable2Step {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Active,
        Repaid,
        Liquidated
    }

    struct Loan {
        address borrower;
        uint256 principal; // USDC wei (6 decimals)
        uint64 maturityTs;
        uint32 haircutBps;
        bytes32 paramsHash;
        bytes32 attestationHash;
        Status status;
    }

    /// @notice The wired LpVault. Immutable for the lifetime of the LoanBook.
    LpVault public immutable lpVault;

    /// @notice The LoanBook's accounting universe is the LpVault asset.
    IERC20 public immutable usdc;

    /// @notice Loans by id. The id is opaque to this contract — origination
    ///         logic chooses it (typically a hash of off-chain origination
    ///         inputs, including a nonce).
    mapping(bytes32 loanId => Loan) public loans;

    /// @notice Sum of all `principal` for loans currently in `Active` status.
    ///         This is the figure LpVault.totalAssets() consumes via
    ///         `outstandingPrincipal()`.
    uint256 public outstandingPrincipal;

    error LoanIdInUse(bytes32 loanId);
    error LoanNotActive(bytes32 loanId, Status status);
    error PrincipalIsZero();
    error AlreadyWired();
    error VaultMismatch(address expected, address actual);
    error FeeBpsAboveCap(uint16 bps, uint16 cap);
    error FeeReceiverZero();
    error FeeExceedsPrincipal(uint256 fee, uint256 principal);

    event Originated(
        bytes32 indexed loanId,
        address indexed borrower,
        uint256 principal,
        uint32 haircutBps,
        uint64 maturityTs,
        bytes32 attestationHash,
        bytes32 paramsHash
    );
    /// @notice Origination fee charged on a loan. Emitted whenever the
    ///         borrower receives `principal - fee` and `feeReceiver`
    ///         receives `fee`. `fee == 0` originations skip this event.
    event OriginationFeeCharged(
        bytes32 indexed loanId,
        address indexed feeReceiver,
        uint256 fee,
        uint16 feeBps
    );
    event OriginationFeeBpsUpdated(uint16 oldBps, uint16 newBps);
    event FeeReceiverUpdated(address indexed oldReceiver, address indexed newReceiver);
    /// @notice Borrower repaid in full. `principal` is the recovered amount
    ///         (always equals `loan.principal`; emitted for log-side
    ///         convenience so consumers don't have to re-read the loan).
    event Repaid(bytes32 indexed loanId, address indexed borrower, uint256 principal);
    /// @notice Loan liquidated. `proceeds` is what the auction escrow
    ///         actually delivered (may be < principal — the LpVault then
    ///         realises the loss the next time `totalAssets()` is read).
    event Liquidated(bytes32 indexed loanId, address indexed auctionEscrow, uint256 proceeds);

    /// @notice Maximum permitted origination fee (5%). Owner can set
    ///         feeBps anywhere in [0, FEE_BPS_CAP]; values above revert.
    uint16 public constant FEE_BPS_CAP = 500;

    /// @notice Origination fee in basis points (1bps = 0.01%). Charged
    ///         on `originate()`: borrower receives `principal - fee`,
    ///         feeReceiver receives `fee`. The loan record's `principal`
    ///         is unchanged — the borrower repays full principal at
    ///         maturity (standard origination-fee accounting). Owner-
    ///         settable; capped at FEE_BPS_CAP.
    uint16 public feeBps;

    /// @notice Recipient of origination fees. The HKDF-derived
    ///         `vanta-agent-treasury-v1` EOA in production. Owner-set
    ///         post-deploy via `setFeeReceiver` so the LoanBook can be
    ///         deployed before the runtime exposes its treasury address
    ///         (the IKM seed lives only inside the enclave).
    address public feeReceiver;

    /// @param usdc_ Vault asset; must equal `lpVault_.asset()`.
    /// @param lpVault_ Pre-deployed LpVault; LoanBook gets wired in via the
    ///                 vault's two-step accept path.
    /// @param admin_ Origination admin (Ownable2Step). Drives every state
    ///               transition; does not custody funds.
    constructor(IERC20 usdc_, LpVault lpVault_, address admin_) Ownable(admin_) {
        if (address(usdc_) != lpVault_.asset()) {
            revert VaultMismatch(lpVault_.asset(), address(usdc_));
        }
        usdc = usdc_;
        lpVault = lpVault_;
        // feeBps and feeReceiver default to 0 / address(0); owner enables
        // the fee path post-deploy via setOriginationFeeBps + setFeeReceiver.
    }

    // -----------------------------------------------------------------------
    // Fee admin (owner-only)
    // -----------------------------------------------------------------------

    /// @notice Update origination fee. Capped at FEE_BPS_CAP (5%). Setting
    ///         to 0 disables the fee path; existing loans are unaffected
    ///         since `principal` is fixed at origination.
    function setOriginationFeeBps(uint16 newBps) external onlyOwner {
        if (newBps > FEE_BPS_CAP) revert FeeBpsAboveCap(newBps, FEE_BPS_CAP);
        uint16 old = feeBps;
        feeBps = newBps;
        emit OriginationFeeBpsUpdated(old, newBps);
    }

    /// @notice Update fee receiver. Reverts on zero address (unset
    ///         receiver while feeBps > 0 would burn the fee). Set
    ///         feeBps = 0 first if you want to disable the path entirely.
    function setFeeReceiver(address newReceiver) external onlyOwner {
        if (newReceiver == address(0)) revert FeeReceiverZero();
        address old = feeReceiver;
        feeReceiver = newReceiver;
        emit FeeReceiverUpdated(old, newReceiver);
    }

    // -----------------------------------------------------------------------
    // ILoanBook view consumed by LpVault.totalAssets()
    // -----------------------------------------------------------------------

    /// @dev Matches the `ILoanBook` interface signature. Solidity does not
    ///      require an explicit `is ILoanBook` declaration — the public
    ///      getter on `outstandingPrincipal` already satisfies the signature.

    // -----------------------------------------------------------------------
    // Wiring helper
    // -----------------------------------------------------------------------

    /// @notice Accept the LpVault wiring. The vault's `acceptLoanBook` is
    ///         only callable by `pendingLoanBook` — which is this contract.
    ///         This wrapper lets the admin drive both halves of the
    ///         propose/accept ceremony from the deployer machine without
    ///         any private key for the LoanBook itself.
    function acceptLpVaultWiring() external onlyOwner {
        if (lpVault.loanBook() == address(this)) revert AlreadyWired();
        lpVault.acceptLoanBook();
    }

    // -----------------------------------------------------------------------
    // State transitions — None → Active → {Repaid, Liquidated}
    // -----------------------------------------------------------------------

    /// @notice Originate a new loan. Pulls `principal` USDC from the LpVault
    ///         (via `drawFor`) and sends it to `borrower`.
    /// @dev I-LB-5: paramsHash = keccak256(abi.encode(borrower, principal,
    ///      haircutBps, maturityTs)). The `attestationHash` is the off-chain
    ///      origination receipt commitment — the contract does not interpret
    ///      it, only stamps it into the event.
    function originate(
        bytes32 loanId,
        address borrower,
        uint256 principal,
        uint32 haircutBps,
        uint64 maturityTs,
        bytes32 attestationHash
    ) external onlyOwner {
        if (principal == 0) revert PrincipalIsZero();
        if (loans[loanId].status != Status.None) revert LoanIdInUse(loanId);

        bytes32 paramsHash = keccak256(
            abi.encode(borrower, principal, haircutBps, maturityTs)
        );

        loans[loanId] = Loan({
            borrower: borrower,
            principal: principal,
            maturityTs: maturityTs,
            haircutBps: haircutBps,
            paramsHash: paramsHash,
            attestationHash: attestationHash,
            status: Status.Active
        });
        outstandingPrincipal += principal;

        // Origination-fee split: the borrower receives `principal - fee`,
        // the fee goes to feeReceiver. Loan record `principal` is the
        // amount the borrower owes at maturity (standard origination-fee
        // accounting — borrower bears the cost). When feeBps is 0 or
        // feeReceiver is unset, behavior is identical to the no-fee path:
        // a single drawFor of the full principal to the borrower.
        uint16 _bps = feeBps;
        address _receiver = feeReceiver;
        uint256 fee = 0;
        if (_bps != 0 && _receiver != address(0)) {
            fee = (principal * _bps) / 10_000;
            if (fee >= principal) revert FeeExceedsPrincipal(fee, principal);
        }

        if (fee == 0) {
            lpVault.drawFor(borrower, principal);
        } else {
            lpVault.drawFor(borrower, principal - fee);
            lpVault.drawFor(_receiver, fee);
            emit OriginationFeeCharged(loanId, _receiver, fee, _bps);
        }

        emit Originated(
            loanId, borrower, principal, haircutBps, maturityTs, attestationHash, paramsHash
        );
    }

    /// @notice Mark a loan repaid. Pulls `principal` USDC from the
    ///         borrower (who must have approved the LoanBook for at least
    ///         `principal`) into the LpVault, then flips state.
    /// @dev I-LB-3: Active → Repaid is a one-way transition. Repaid →
    ///      anything reverts.
    ///
    ///      Pull pattern (vs. push) keeps the LoanBook the single
    ///      authority over the LpVault accounting universe: the vault's
    ///      `totalAssets()` is monotone and only changes when LoanBook
    ///      drives a transition. The borrower must have called
    ///      `usdc.approve(loanBook, principal)` beforehand.
    function markRepaid(bytes32 loanId) external onlyOwner {
        Loan storage l = loans[loanId];
        if (l.status != Status.Active) revert LoanNotActive(loanId, l.status);

        // Cache before state-flip so a hostile borrower can't reorg us
        // into reading a freshly-zeroed `principal`.
        address borrower = l.borrower;
        uint256 principal = l.principal;

        l.status = Status.Repaid;
        outstandingPrincipal -= principal;

        // Pull repayment from borrower → LpVault. SafeERC20 reverts on
        // insufficient allowance / balance, which propagates as the entire
        // markRepaid call reverting (state flip is rolled back).
        usdc.safeTransferFrom(borrower, address(lpVault), principal);

        emit Repaid(loanId, borrower, principal);
    }

    /// @notice Mark a loan liquidated. Pulls `proceeds` USDC from
    ///         `auctionEscrow` (which must have approved the LoanBook
    ///         for at least `proceeds`) into the LpVault, then flips
    ///         state. `proceeds` may be < `loan.principal` — the
    ///         shortfall realises as a loss in `LpVault.totalAssets()`
    ///         the next time it is read.
    /// @dev I-LB-3: Active → Liquidated is a one-way transition.
    ///
    ///      `auctionEscrow == address(0)` and `proceeds == 0` is allowed
    ///      to record a total-loss case where the venue did not return
    ///      anything (recovery already failed off-chain).
    function markLiquidated(
        bytes32 loanId,
        address auctionEscrow,
        uint256 proceeds
    ) external onlyOwner {
        Loan storage l = loans[loanId];
        if (l.status != Status.Active) revert LoanNotActive(loanId, l.status);

        l.status = Status.Liquidated;
        outstandingPrincipal -= l.principal;

        if (proceeds != 0) {
            usdc.safeTransferFrom(auctionEscrow, address(lpVault), proceeds);
        }

        emit Liquidated(loanId, auctionEscrow, proceeds);
    }
}
