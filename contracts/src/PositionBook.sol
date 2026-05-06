// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {AgentPoolVault} from "./AgentPoolVault.sol";

/// @title PositionBook — VANTA v3 trade lifecycle state machine.
/// @notice One position-per-id, owner-driven (None → Open → Closed). Paired
///         1:1 with an AgentPoolVault (per VANTA). The contract records
///         entries + exits for audit; venue interaction (Polymarket CLOB
///         order placement) happens off-chain via the relayer EOA.
/// @dev    Invariants:
///           - I-PB-1: no reverse transitions. Once Closed, a positionId
///             is terminal.
///           - I-PB-2: paramsHash binds (marketId, side, sizeUsdc6,
///             entryPriceBps).
///           - I-PB-3: openNotionalUsdc6 = Σ size of currently-Open
///             positions; mirrors what AgentPoolVault tracks via
///             onPositionOpened/onPositionClosed.
contract PositionBook is Ownable2Step {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Open,
        Closed
    }

    enum Side {
        Yes,
        No
    }

    struct Position {
        bytes32 marketId;        // Polymarket conditionId (32 bytes)
        Side side;
        uint256 sizeUsdc6;       // USDC spent at entry (cost basis)
        uint32 entryPriceBps;    // 0..10000 — 1.0 = 10000
        uint64 openedAt;
        uint32 exitPriceBps;     // 0..10000; set on close
        uint256 proceedsUsdc6;   // USDC returned at close
        uint64 closedAt;
        bytes32 paramsHash;
        bytes32 attestationHash;
        Status status;
    }

    /// @notice Stable AgentRegistry id; matches the paired vault.
    uint256 public immutable agentId;

    /// @notice The paired AgentPoolVault. Immutable for the lifetime of
    ///         the PositionBook.
    AgentPoolVault public immutable vault;

    /// @notice The vault's accounting universe.
    IERC20 public immutable usdc;

    /// @notice Positions by id. Id is opaque to this contract — runtime
    ///         chooses it (typically a hash of off-chain trade-decision
    ///         inputs including a nonce).
    mapping(bytes32 positionId => Position) public positions;

    /// @notice Sum of cost basis for currently-Open positions (USDC wei).
    ///         Mirrors AgentPoolVault.openPositionsValueUsdc6 at entry
    ///         time; vault's number drifts under mark-to-market while
    ///         this stays at cost basis.
    uint256 public openNotionalUsdc6;

    /// @notice Lifetime sum of `sizeUsdc6` across all closed positions
    ///         (cost basis of closed trades).
    uint256 public lifetimeCostBasisUsdc6;

    /// @notice Lifetime sum of `proceedsUsdc6` across all closed
    ///         positions. Realised PnL = lifetimeProceedsUsdc6 -
    ///         lifetimeCostBasisUsdc6 (signed in the off-chain reading).
    uint256 public lifetimeProceedsUsdc6;

    error PositionIdInUse(bytes32 positionId);
    error PositionNotOpen(bytes32 positionId, Status status);
    error SizeIsZero();
    error PriceOutOfRange(uint32 priceBps);
    error VaultMismatch(address expected, address actual);
    error AlreadyWired();

    event Opened(
        bytes32 indexed positionId,
        bytes32 indexed marketId,
        Side side,
        uint256 sizeUsdc6,
        uint32 entryPriceBps,
        bytes32 attestationHash,
        bytes32 paramsHash,
        uint64 openedAt
    );
    event Closed(
        bytes32 indexed positionId,
        uint32 exitPriceBps,
        uint256 proceedsUsdc6,
        bytes32 attestationHash,
        uint64 closedAt
    );

    /// @param vault_ Pre-deployed AgentPoolVault. Must already be
    ///        proposed-as-positionBook before this contract is deployed
    ///        (or accept happens via `acceptVaultWiring()` post-deploy).
    /// @param admin_ Owner — same TEE EOA as the vault's owner.
    constructor(AgentPoolVault vault_, address admin_) Ownable(admin_) {
        agentId = vault_.agentId();
        vault = vault_;
        usdc = IERC20(vault_.asset());
    }

    // -----------------------------------------------------------------------
    // Wiring helper (owner accepts the vault's pendingPositionBook proposal
    // by routing through this contract — same pattern as LoanBook)
    // -----------------------------------------------------------------------

    /// @notice Accept the vault's pendingPositionBook proposal. Vault's
    ///         `acceptPositionBook` is callable only by `pendingPositionBook`
    ///         which is this contract. The owner drives both halves of the
    ///         ceremony from the deployer machine.
    function acceptVaultWiring() external onlyOwner {
        if (vault.positionBook() == address(this)) revert AlreadyWired();
        vault.acceptPositionBook();
    }

    // -----------------------------------------------------------------------
    // State transitions — None → Open → Closed
    // -----------------------------------------------------------------------

    /// @notice Open a new position. Pulls `sizeUsdc6` USDC from the vault
    ///         (via `onPositionOpened`) and sends it to the relayer (the
    ///         owner). The relayer places the venue order off-chain.
    /// @dev I-PB-2: paramsHash = keccak256(abi.encode(marketId, side,
    ///      sizeUsdc6, entryPriceBps)). attestationHash is the off-chain
    ///      decision-event commitment; the contract stamps but does not
    ///      interpret it.
    function open(
        bytes32 positionId,
        bytes32 marketId,
        Side side,
        uint256 sizeUsdc6,
        uint32 entryPriceBps,
        bytes32 attestationHash
    ) external onlyOwner {
        if (sizeUsdc6 == 0) revert SizeIsZero();
        if (entryPriceBps == 0 || entryPriceBps >= 10_000) revert PriceOutOfRange(entryPriceBps);
        if (positions[positionId].status != Status.None) revert PositionIdInUse(positionId);

        bytes32 paramsHash = keccak256(
            abi.encode(marketId, side, sizeUsdc6, entryPriceBps)
        );

        positions[positionId] = Position({
            marketId: marketId,
            side: side,
            sizeUsdc6: sizeUsdc6,
            entryPriceBps: entryPriceBps,
            openedAt: uint64(block.timestamp),
            exitPriceBps: 0,
            proceedsUsdc6: 0,
            closedAt: 0,
            paramsHash: paramsHash,
            attestationHash: attestationHash,
            status: Status.Open
        });
        openNotionalUsdc6 += sizeUsdc6;

        // Vault transfers USDC to the relayer (owner). Vault tracks
        // openPositionsValueUsdc6 internally so totalAssets() doesn't
        // jump at entry.
        vault.onPositionOpened(owner(), sizeUsdc6, sizeUsdc6);

        emit Opened(
            positionId,
            marketId,
            side,
            sizeUsdc6,
            entryPriceBps,
            attestationHash,
            paramsHash,
            uint64(block.timestamp)
        );
    }

    /// @notice Close an open position. The relayer must have already
    ///         settled the position off-chain and pulled `proceedsUsdc6`
    ///         back to its EOA. The contract pulls those USDC from the
    ///         relayer (owner) into the vault, flips state, and updates
    ///         lifetime accounting.
    /// @dev I-PB-1: Open → Closed is one-way.
    ///      The owner must have called `usdc.approve(positionBook,
    ///      proceedsUsdc6)` beforehand.
    function close(
        bytes32 positionId,
        uint32 exitPriceBps,
        uint256 proceedsUsdc6,
        bytes32 attestationHash
    ) external onlyOwner {
        if (exitPriceBps > 10_000) revert PriceOutOfRange(exitPriceBps);
        Position storage p = positions[positionId];
        if (p.status != Status.Open) revert PositionNotOpen(positionId, p.status);

        uint256 size = p.sizeUsdc6;

        p.status = Status.Closed;
        p.exitPriceBps = exitPriceBps;
        p.proceedsUsdc6 = proceedsUsdc6;
        p.closedAt = uint64(block.timestamp);
        p.attestationHash = attestationHash;
        openNotionalUsdc6 -= size;
        lifetimeCostBasisUsdc6 += size;
        lifetimeProceedsUsdc6 += proceedsUsdc6;

        // Pull proceeds from owner (relayer) into the vault. Vault
        // updates accounting via onPositionClosed.
        if (proceedsUsdc6 != 0) {
            usdc.safeTransferFrom(msg.sender, address(vault), proceedsUsdc6);
        }
        vault.onPositionClosed(proceedsUsdc6, size);

        emit Closed(
            positionId,
            exitPriceBps,
            proceedsUsdc6,
            attestationHash,
            uint64(block.timestamp)
        );
    }
}
