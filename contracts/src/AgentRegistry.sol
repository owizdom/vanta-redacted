// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title AgentRegistry — shared multi-VANTA registry.
/// @notice One deployment, holds the canonical list of registered VANTAs.
///         Each VANTA registers its triple of contracts (AgentPoolVault,
///         PositionBook, OperationalCap) plus metadata: name, thesis,
///         imageDigest (the runtime container digest pinned on chain),
///         colorRgb (drives the island palette in the watchable layer).
/// @dev    Permissionless: anyone holding `bondUsdc6` USDC can register a
///         VANTA. Bond is held by the registry; v3.0 has no slashing or
///         withdrawal — bond is "fee for permanent listing." Owner is the
///         protocol admin who can `pauseAgent` for emergencies.
///
///         Invariants:
///           - I-AR-1: agentIds are sequential from 0; once assigned never
///             re-used.
///           - I-AR-2: `bondUsdc6` is immutable post-deploy.
///           - I-AR-3: each agent's `pool`, `positionBook`, `opCap` triple
///             must consistently report the same `agentId` in their views.
contract AgentRegistry is Ownable2Step {
    using SafeERC20 for IERC20;

    /// @notice USDC used for bond payments.
    IERC20 public immutable usdc;

    /// @notice Per-registration bond, in USDC wei. Immutable.
    uint256 public immutable bondUsdc6;

    /// @notice Where bond is escrowed (the registry itself); v3.0 has no
    ///         withdrawal path so bond effectively becomes a treasury
    ///         contribution. v3.1 may add a slashing/withdrawal mechanism.
    ///         Bond balance is queryable via USDC.balanceOf(registry).
    struct Agent {
        uint256 agentId;
        string name;            // human-readable, e.g. "vanta-zero", "vanta-gpt"
        string thesis;          // free-text thesis/description
        bytes32 imageDigest;    // runtime container digest pinned on chain
        uint24 colorRgb;        // 0xRRGGBB — drives the island palette
        address pool;           // AgentPoolVault address
        address positionBook;   // PositionBook address
        address opCap;          // OperationalCap address
        address operator;       // EOA that registered + owns bond
        bytes32 attestationHash;// off-chain registration attestation
        uint64 registeredAt;
        bool paused;            // owner can pause for emergencies
    }

    /// @notice Total registered count. Equals the next agentId to be
    ///         assigned (since ids start at 0).
    uint256 public count;

    /// @notice Agents by id. agents[0] is the first-registered VANTA;
    ///         convention is to register VANTA-zero (the original Claude
    ///         thesis) as id 0 in the deploy script.
    mapping(uint256 agentId => Agent) public agents;

    /// @notice Reverse lookup: pool address → agentId. Useful for
    ///         consumers receiving deposit/withdraw events tagged by
    ///         pool address.
    mapping(address pool => uint256 agentId) public agentIdByPool;

    /// @notice Set of names (lowercased) to prevent duplicates.
    mapping(bytes32 nameHash => bool) public nameTaken;

    error BondZero();
    error NameEmpty();
    error NameTaken(bytes32 nameHash);
    error TripleMismatch(string field);
    error AgentMissing(uint256 agentId);
    error AgentPaused(uint256 agentId);

    event Registered(
        uint256 indexed agentId,
        address indexed operator,
        address indexed pool,
        string name,
        string thesis,
        bytes32 imageDigest,
        uint24 colorRgb,
        address positionBook,
        address opCap,
        bytes32 attestationHash,
        uint64 registeredAt
    );
    event Paused(uint256 indexed agentId, address indexed by);
    event Unpaused(uint256 indexed agentId, address indexed by);

    /// @param usdc_ USDC token used for bond.
    /// @param bondUsdc6_ Per-registration bond. Must be > 0.
    /// @param admin_ Protocol admin — pause/unpause emergencies.
    constructor(IERC20 usdc_, uint256 bondUsdc6_, address admin_) Ownable(admin_) {
        if (bondUsdc6_ == 0) revert BondZero();
        usdc = usdc_;
        bondUsdc6 = bondUsdc6_;
    }

    // -----------------------------------------------------------------------
    // Registration
    // -----------------------------------------------------------------------

    /// @notice Register a new VANTA. Caller must have approved this
    ///         registry for at least `bondUsdc6` USDC.
    ///
    ///         The triple (pool, positionBook, opCap) is recorded but not
    ///         verified for consistency on chain — off-chain consumers
    ///         should cross-check that each contract reports the agentId
    ///         this registration emits (I-AR-3). v3.1 may add an
    ///         on-chain consistency check via interface calls.
    function register(
        string calldata name,
        string calldata thesis,
        bytes32 imageDigest,
        uint24 colorRgb,
        address pool,
        address positionBook,
        address opCap,
        bytes32 attestationHash
    ) external returns (uint256 agentId) {
        if (bytes(name).length == 0) revert NameEmpty();
        bytes32 nameHash = keccak256(bytes(_lower(name)));
        if (nameTaken[nameHash]) revert NameTaken(nameHash);

        agentId = count;
        count = agentId + 1;

        agents[agentId] = Agent({
            agentId: agentId,
            name: name,
            thesis: thesis,
            imageDigest: imageDigest,
            colorRgb: colorRgb,
            pool: pool,
            positionBook: positionBook,
            opCap: opCap,
            operator: msg.sender,
            attestationHash: attestationHash,
            registeredAt: uint64(block.timestamp),
            paused: false
        });
        nameTaken[nameHash] = true;
        agentIdByPool[pool] = agentId;

        // Pull bond from operator into the registry. Bond is held here;
        // v3.0 has no withdrawal path.
        usdc.safeTransferFrom(msg.sender, address(this), bondUsdc6);

        emit Registered(
            agentId,
            msg.sender,
            pool,
            name,
            thesis,
            imageDigest,
            colorRgb,
            positionBook,
            opCap,
            attestationHash,
            uint64(block.timestamp)
        );
    }

    // -----------------------------------------------------------------------
    // Pause / unpause (admin emergencies)
    // -----------------------------------------------------------------------

    /// @notice Mark an agent paused. The flag is informational only —
    ///         the AgentPoolVault and PositionBook contracts are
    ///         independent and continue to honour their owner's calls.
    ///         Off-chain consumers (front-ends, runtime fleet host) read
    ///         this flag and stop showing / serving the agent.
    function pauseAgent(uint256 agentId) external onlyOwner {
        Agent storage a = agents[agentId];
        if (a.registeredAt == 0) revert AgentMissing(agentId);
        if (a.paused) revert AgentPaused(agentId);
        a.paused = true;
        emit Paused(agentId, msg.sender);
    }

    /// @notice Reverse a previous pause.
    function unpauseAgent(uint256 agentId) external onlyOwner {
        Agent storage a = agents[agentId];
        if (a.registeredAt == 0) revert AgentMissing(agentId);
        a.paused = false;
        emit Unpaused(agentId, msg.sender);
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    /// @notice Single-agent struct getter. The auto-generated public
    ///         mapping getter returns each field separately; this
    ///         wrapper returns the full struct for ergonomic consumer
    ///         code.
    function agentOf(uint256 agentId) external view returns (Agent memory) {
        return agents[agentId];
    }

    /// @notice Paginated listing — returns `len` agents starting at
    ///         `offset`. `len` is clamped at `count - offset`.
    function list(uint256 offset, uint256 len)
        external
        view
        returns (Agent[] memory out)
    {
        uint256 c = count;
        if (offset >= c) {
            return new Agent[](0);
        }
        uint256 actual = len;
        if (offset + actual > c) actual = c - offset;
        out = new Agent[](actual);
        for (uint256 i = 0; i < actual; ++i) {
            out[i] = agents[offset + i];
        }
    }

    /// @notice Deterministic island layout: agents[0] sits at world
    ///         origin, agents[1..N] ring the origin at radius 200 in
    ///         8 cardinal+ordinal positions, then a second ring at
    ///         radius 380, etc. Returns (offsetX, offsetZ) in Minecraft
    ///         block coordinates.
    function islandOffsetOf(uint256 agentId) external pure returns (int32 x, int32 z) {
        if (agentId == 0) return (0, 0);
        // Ring index: 1..8 → ring 1, 9..16 → ring 2, etc.
        uint256 idx = agentId - 1;
        uint256 ring = (idx / 8) + 1;
        uint256 slot = idx % 8;
        // 8-position table in cardinal/ordinal order: N, NE, E, SE, S, SW, W, NW
        // Pre-computed at radius 200 (then scaled by ring).
        int32[8] memory dx = [int32(0), 141, 200, 141, 0, -141, -200, -141];
        int32[8] memory dz = [int32(-200), -141, 0, 141, 200, 141, 0, -141];
        // Each subsequent ring is 180 blocks further out (200 + (ring-1)*180).
        int32 r = int32(int256(200 + (ring - 1) * 180));
        x = (dx[slot] * r) / int32(200);
        z = (dz[slot] * r) / int32(200);
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    function _lower(string memory s) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        for (uint256 i = 0; i < b.length; ++i) {
            uint8 c = uint8(b[i]);
            if (c >= 65 && c <= 90) {
                b[i] = bytes1(c + 32);
            }
        }
        return string(b);
    }
}
