// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title OperationalCap — per-VANTA weekly USDC cap on operational spend.
/// @notice The agent's runtime calls `pay(amount)` to push USDC from the
///         agent's treasury (caller) to the immutable `payee`. Every payment
///         is rate-limited on chain by `weeklyCapUsdc6` over a calendar-week
///         window. The cap and payee are immutable — changing them requires
///         a fresh deployment. This is the load-bearing security property:
///         even a compromised runtime cannot drain the agent's treasury
///         beyond the per-week cap.
/// @dev    Adapted from VendorPayment.sol with the addition of `agentId` so
///         OperationalCap deployments are 1:1 with AgentPoolVault deployments
///         and events can be filtered per VANTA. The contract holds no funds:
///         `pay` does `transferFrom(caller, payee)` atomically with the cap
///         check, so partial-success is impossible.
contract OperationalCap is Ownable2Step {
    using SafeERC20 for IERC20;

    /// @notice USDC on Base Sepolia. Immutable.
    IERC20 public immutable usdc;

    /// @notice Stable AgentRegistry id; matches the paired vault.
    uint256 public immutable agentId;

    /// @notice Fixed recipient — typically the agent's "ops wallet" that
    ///         pays gas relays, oracle reads, inference relayer fees, etc.
    address public immutable payee;

    /// @notice Per-7-day cap in USDC wei (6 decimals). Cannot be raised.
    uint256 public immutable weeklyCapUsdc6;

    /// @notice Genesis SCO entry id this op-cap is bound to.
    bytes32 public immutable constitutionalRef;

    /// @notice Tally of USDC paid in each calendar-week window. Window
    ///         key is `block.timestamp / 7 days`.
    mapping(uint256 weekId => uint256 paidUsdc6) public paidThisWeek;

    error AmountIsZero();
    error WeeklyCapExceeded(uint256 weekId, uint256 paid, uint256 amount, uint256 cap);
    error PayeeZero();
    error WeeklyCapZero();

    event Paid(
        uint256 indexed weekId,
        uint256 indexed agentId,
        uint256 amount,
        uint256 paidThisWeekTotal,
        uint256 timestamp
    );

    /// @param usdc_ ERC-20 token used for all settlements.
    /// @param agentId_ Stable AgentRegistry id for this VANTA.
    /// @param payee_ Fixed recipient; immutable.
    /// @param weeklyCapUsdc6_ Per-week cap in token wei; immutable.
    /// @param admin_ Initial owner — the per-VANTA TEE EOA.
    /// @param constitutionalRef_ Genesis SCO entry id binding this op-cap.
    constructor(
        IERC20 usdc_,
        uint256 agentId_,
        address payee_,
        uint256 weeklyCapUsdc6_,
        address admin_,
        bytes32 constitutionalRef_
    ) Ownable(admin_) {
        if (payee_ == address(0)) revert PayeeZero();
        if (weeklyCapUsdc6_ == 0) revert WeeklyCapZero();
        usdc = usdc_;
        agentId = agentId_;
        payee = payee_;
        weeklyCapUsdc6 = weeklyCapUsdc6_;
        constitutionalRef = constitutionalRef_;
    }

    /// @notice Current week id, suitable for indexing `paidThisWeek`.
    function currentWeekId() external view returns (uint256) {
        return block.timestamp / 7 days;
    }

    /// @notice Push `amount` USDC from `msg.sender` to `payee`. Caller
    ///         must hold sufficient USDC and have granted this contract
    ///         `allowance >= amount`. Reverts if the resulting weekly
    ///         tally would exceed `weeklyCapUsdc6`.
    function pay(uint256 amount) external onlyOwner {
        if (amount == 0) revert AmountIsZero();
        uint256 weekId = block.timestamp / 7 days;
        uint256 priorPaid = paidThisWeek[weekId];
        uint256 newPaid = priorPaid + amount;
        if (newPaid > weeklyCapUsdc6) {
            revert WeeklyCapExceeded(weekId, priorPaid, amount, weeklyCapUsdc6);
        }
        paidThisWeek[weekId] = newPaid;
        usdc.safeTransferFrom(msg.sender, payee, amount);
        emit Paid(weekId, agentId, amount, newPaid, block.timestamp);
    }
}
