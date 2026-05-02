// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title VendorPayment — constitutionally-bounded weekly USDC stream to a fixed payee.
/// @notice The agent's runtime calls `pay(amount)` to push USDC from the
///         treasury (caller) to the immutable `vendorPayee`. Every payment is
///         rate-limited on chain by `weeklyCapUsdc6` over a calendar-week
///         window (`block.timestamp / 7 days`). The cap, payee, and
///         `constitutionalRef` are immutable post-deploy: changing any of them
///         requires a fresh deployment under a new constitutional ref. This is
///         the load-bearing security property — even a compromised runtime
///         cannot drain the treasury beyond the constitutional commitment.
/// @dev    The contract holds no funds: `pay` does
///         `transferFrom(caller, payee)` atomically with the cap check, so
///         partial-success is impossible. The owner is the agent's treasury
///         EOA; only the owner may call `pay`. Ownership transfer follows
///         OpenZeppelin Ownable2Step (a compromised key still cannot
///         single-step transfer ownership to an attacker-controlled address).
contract VendorPayment is Ownable2Step {
    using SafeERC20 for IERC20;

    /// @notice USDC on Base Sepolia. Immutable for the contract's lifetime.
    IERC20 public immutable usdc;

    /// @notice Fixed recipient. Set at deploy; cannot be changed.
    address public immutable vendorPayee;

    /// @notice Per-7-day cap in USDC wei (6 decimals). Cannot be raised.
    uint256 public immutable weeklyCapUsdc6;

    /// @notice Genesis SCO entry id this payment stream is bound to. The
    ///         runtime asserts at boot that its config matches; the verifier
    ///         can resolve the ref to a published constitutional clause.
    bytes32 public immutable constitutionalRef;

    /// @notice Tally of USDC paid in each calendar-week window. Window key is
    ///         `block.timestamp / 7 days` — agnostic to deploy time so all
    ///         vendors share the same week boundary.
    mapping(uint256 weekId => uint256 paidUsdc6) public paidThisWeek;

    error AmountIsZero();
    error WeeklyCapExceeded(uint256 weekId, uint256 paid, uint256 amount, uint256 cap);
    error VendorPayeeZero();
    error WeeklyCapZero();

    /// @notice Emitted on every successful `pay`. `paidThisWeekTotal` is the
    ///         running total *after* this payment lands so consumers don't
    ///         need to re-read storage to plot weekly burn.
    event Paid(
        uint256 indexed weekId,
        uint256 amount,
        uint256 paidThisWeekTotal,
        uint256 timestamp
    );

    /// @param usdc_ ERC-20 token used for all settlements.
    /// @param vendorPayee_ Fixed recipient; immutable.
    /// @param weeklyCapUsdc6_ Per-week cap in token wei; immutable.
    /// @param admin_ Initial owner; the agent's treasury EOA. Drives `pay`.
    /// @param constitutionalRef_ Genesis SCO entry id binding this stream.
    constructor(
        IERC20 usdc_,
        address vendorPayee_,
        uint256 weeklyCapUsdc6_,
        address admin_,
        bytes32 constitutionalRef_
    ) Ownable(admin_) {
        if (vendorPayee_ == address(0)) revert VendorPayeeZero();
        if (weeklyCapUsdc6_ == 0) revert WeeklyCapZero();
        usdc = usdc_;
        vendorPayee = vendorPayee_;
        weeklyCapUsdc6 = weeklyCapUsdc6_;
        constitutionalRef = constitutionalRef_;
    }

    /// @notice The current week id, suitable for indexing `paidThisWeek`.
    function currentWeekId() external view returns (uint256) {
        return block.timestamp / 7 days;
    }

    /// @notice Push `amount` USDC from `msg.sender` to `vendorPayee`. Caller
    ///         must hold sufficient USDC and have granted this contract
    ///         `allowance >= amount`. Reverts if the resulting weekly tally
    ///         would exceed `weeklyCapUsdc6`.
    /// @dev    `transferFrom` is atomic with the cap check; partial-success
    ///         is impossible. Owner-only so the agent's treasury is the
    ///         sole caller.
    function pay(uint256 amount) external onlyOwner {
        if (amount == 0) revert AmountIsZero();
        uint256 weekId = block.timestamp / 7 days;
        uint256 priorPaid = paidThisWeek[weekId];
        uint256 newPaid = priorPaid + amount;
        if (newPaid > weeklyCapUsdc6) {
            revert WeeklyCapExceeded(weekId, priorPaid, amount, weeklyCapUsdc6);
        }
        paidThisWeek[weekId] = newPaid;
        usdc.safeTransferFrom(msg.sender, vendorPayee, amount);
        emit Paid(weekId, amount, newPaid, block.timestamp);
    }
}
