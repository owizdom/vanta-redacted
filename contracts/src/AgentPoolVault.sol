// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20, IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title AgentPoolVault — VANTA v3 trading-agent pool (ERC-4626).
/// @notice Per-VANTA USDC pool. Depositors receive vAGT-N share tokens
///         (where N is `agentId`); shares represent pro-rata claim on the
///         agent's idle USDC + open-position notional value.
/// @dev    Invariants:
///           - I-AP-1: `totalAssets() = USDC balance + openPositionsValueUsdc6`.
///           - I-AP-2: asset is hard-pinned to canonical Base mainnet USDC.
///           - I-AP-3: `_decimalsOffset() == 6` — virtual shares neutralise
///             the classic ERC-4626 inflation attack.
///           - I-AP-4: `maxDeposit(any) == 0` once `totalAssets() >= maxAumUsdc6`.
///             v3.0 caps each VANTA at the `maxAumUsdc6` immutable so book
///             depth on Polymarket isn't moved by a single agent's entries.
///           - I-AP-5: `openPositionsValueUsdc6` is owner-settable via
///             `markPositions` (mark-to-market) and PositionBook-settable
///             via `onPositionOpened`/`onPositionClosed`. No other path
///             mutates it.
contract AgentPoolVault is ERC4626, Ownable2Step {
    using SafeERC20 for IERC20;

    /// @notice Canonical Base mainnet USDC (Circle native).
    address public constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    /// @notice Stable identifier for this VANTA across the AgentRegistry.
    ///         All on-chain events emit this so consumers can filter by
    ///         agent without mapping addresses.
    uint256 public immutable agentId;

    /// @notice Programmatic AUM cap, in USDC wei (6 decimals). Set at
    ///         deploy and never changed. v3.0 default: 10_000 USDC.
    ///         Once `totalAssets() >= maxAumUsdc6`, deposits revert; this
    ///         keeps each VANTA below Polymarket book-depth limits.
    uint256 public immutable maxAumUsdc6;

    /// @notice The wired PositionBook. `address(0)` while unwired.
    address public positionBook;

    /// @notice PositionBook awaiting `acceptPositionBook`. Cleared on
    ///         accept or on a fresh proposal.
    address public pendingPositionBook;

    /// @notice Sum of current notional value of all open positions, in
    ///         USDC wei. Updated by:
    ///           - `onPositionOpened` (PositionBook) at entry
    ///           - `onPositionClosed` (PositionBook) at exit
    ///           - `markPositions` (owner) for mark-to-market between
    ///             entry and exit
    uint256 public openPositionsValueUsdc6;

    error BadAsset(address asset);
    error MaxAumZero();
    error NotPendingPositionBook(address sender);
    error PendingPositionBookUnset();
    error NotPositionBook(address sender);
    error PositionBookUnset();
    error AumCapWouldBeExceeded(uint256 requested, uint256 cap);

    event PositionBookProposed(address indexed pending);
    event PositionBookAccepted(address indexed positionBook);
    event TradeOpenedDraw(address indexed to, uint256 usdcOut, uint256 entryNotionalUsdc6);
    event TradeClosedReturn(uint256 proceedsUsdc6, uint256 exitNotionalUsdc6);
    event MarkedToMarket(uint256 newOpenPositionsValueUsdc6, uint256 timestamp);

    /// @param asset_ Must equal `BASE_USDC` (I-AP-2).
    /// @param admin_ Initial owner — the per-VANTA TEE EOA.
    /// @param agentId_ Stable AgentRegistry id for this VANTA.
    /// @param maxAumUsdc6_ Per-VANTA AUM cap in USDC wei. Must be > 0.
    constructor(
        IERC20 asset_,
        address admin_,
        uint256 agentId_,
        uint256 maxAumUsdc6_
    )
        ERC20(_buildName(agentId_), _buildSymbol(agentId_))
        ERC4626(asset_)
        Ownable(admin_)
    {
        if (address(asset_) != BASE_USDC) revert BadAsset(address(asset_));
        if (maxAumUsdc6_ == 0) revert MaxAumZero();
        agentId = agentId_;
        maxAumUsdc6 = maxAumUsdc6_;
    }

    // -----------------------------------------------------------------------
    // ERC-4626 overrides
    // -----------------------------------------------------------------------

    /// @inheritdoc ERC4626
    /// @dev I-AP-3 — virtual shares scaled by 10**12 against virtual assets.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    /// @inheritdoc ERC4626
    /// @dev I-AP-1.
    function totalAssets() public view override returns (uint256) {
        return IERC20(asset()).balanceOf(address(this)) + openPositionsValueUsdc6;
    }

    /// @inheritdoc ERC4626
    /// @dev I-AP-4 — programmatic per-VANTA AUM cap.
    function maxDeposit(address) public view override returns (uint256) {
        uint256 total = totalAssets();
        if (total >= maxAumUsdc6) return 0;
        return maxAumUsdc6 - total;
    }

    /// @inheritdoc ERC4626
    function maxMint(address receiver) public view override returns (uint256) {
        uint256 cap = maxDeposit(receiver);
        if (cap == 0) return 0;
        return convertToShares(cap);
    }

    // -----------------------------------------------------------------------
    // Two-step PositionBook wiring (mirrors LpVault.proposeLoanBook pattern)
    // -----------------------------------------------------------------------

    /// @notice Propose a PositionBook. Owner-only.
    function proposePositionBook(address next) external onlyOwner {
        pendingPositionBook = next;
        emit PositionBookProposed(next);
    }

    /// @notice The pending PositionBook accepts the proposal, becoming live.
    function acceptPositionBook() external {
        address pending = pendingPositionBook;
        if (pending == address(0)) revert PendingPositionBookUnset();
        if (msg.sender != pending) revert NotPendingPositionBook(msg.sender);
        positionBook = pending;
        pendingPositionBook = address(0);
        emit PositionBookAccepted(pending);
    }

    // -----------------------------------------------------------------------
    // PositionBook-driven movement (open / close)
    // -----------------------------------------------------------------------

    /// @notice Move USDC out of the vault to fund a new trade. Called by
    ///         PositionBook at trade open. The destination is typically the
    ///         agent's relayer EOA (which then places the order on the
    ///         venue and takes custody of position tokens).
    /// @param to Destination of the USDC.
    /// @param usdcOut USDC wei to draw out of the vault.
    /// @param entryNotionalUsdc6 Notional value at entry — the agent's
    ///        accounting basis for this open position. This is added to
    ///        `openPositionsValueUsdc6` so totalAssets() doesn't drop on
    ///        entry (the position is worth its entry-mark, not zero).
    function onPositionOpened(
        address to,
        uint256 usdcOut,
        uint256 entryNotionalUsdc6
    ) external {
        if (positionBook == address(0)) revert PositionBookUnset();
        if (msg.sender != positionBook) revert NotPositionBook(msg.sender);
        IERC20(asset()).safeTransfer(to, usdcOut);
        openPositionsValueUsdc6 += entryNotionalUsdc6;
        emit TradeOpenedDraw(to, usdcOut, entryNotionalUsdc6);
    }

    /// @notice Recognise position closure. Called by PositionBook after the
    ///         relayer has returned `proceedsUsdc6` to the vault (USDC must
    ///         already be in the vault — PositionBook does the
    ///         `safeTransferFrom` from the relayer in `close()`).
    /// @param proceedsUsdc6 USDC wei the position is being closed for.
    ///        Already in the vault by the time this is called; the vault
    ///        updates accounting only.
    /// @param exitNotionalUsdc6 The notional that was open for this
    ///        position. Subtracted from `openPositionsValueUsdc6`.
    function onPositionClosed(
        uint256 proceedsUsdc6,
        uint256 exitNotionalUsdc6
    ) external {
        if (positionBook == address(0)) revert PositionBookUnset();
        if (msg.sender != positionBook) revert NotPositionBook(msg.sender);
        // Underflow-safe subtraction: if a mark-to-market underflowed
        // openPositionsValueUsdc6, the vault still functions but
        // accounting is best-effort. Owner can re-mark if needed.
        if (exitNotionalUsdc6 >= openPositionsValueUsdc6) {
            openPositionsValueUsdc6 = 0;
        } else {
            openPositionsValueUsdc6 -= exitNotionalUsdc6;
        }
        emit TradeClosedReturn(proceedsUsdc6, exitNotionalUsdc6);
    }

    // -----------------------------------------------------------------------
    // Mark-to-market (owner-only)
    // -----------------------------------------------------------------------

    /// @notice Update the aggregate value of open positions. Owner is the
    ///         TEE EOA — every call is anchored to a signed event in the
    ///         off-chain audit trail. v3.0 trusts the TEE; v3.1 may add
    ///         per-call rate-limiting or oracle attestation.
    function markPositions(uint256 newOpenPositionsValueUsdc6) external onlyOwner {
        openPositionsValueUsdc6 = newOpenPositionsValueUsdc6;
        emit MarkedToMarket(newOpenPositionsValueUsdc6, block.timestamp);
    }

    // -----------------------------------------------------------------------
    // Helpers — name/symbol per agentId
    // -----------------------------------------------------------------------

    function _buildName(uint256 id) private pure returns (string memory) {
        return string.concat("VANTA agent #", _u2s(id));
    }

    function _buildSymbol(uint256 id) private pure returns (string memory) {
        return string.concat("vAGT-", _u2s(id));
    }

    function _u2s(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 tmp = v;
        uint256 digits;
        while (tmp != 0) { digits++; tmp /= 10; }
        bytes memory buf = new bytes(digits);
        while (v != 0) {
            digits -= 1;
            buf[digits] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(buf);
    }
}
