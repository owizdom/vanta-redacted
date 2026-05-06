// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {AgentPoolVault} from "./AgentPoolVault.sol";
import {PositionBook} from "./PositionBook.sol";
import {OperationalCap} from "./OperationalCap.sol";
import {AgentRegistry} from "./AgentRegistry.sol";

/// @title AgentFactory — atomic per-VANTA deploy helper.
/// @notice Deploys the triple (AgentPoolVault, PositionBook,
///         OperationalCap) for a new VANTA, wires PositionBook to the
///         vault, and registers the agent in the AgentRegistry — all in
///         one transaction. The operator is the EOA calling this; that
///         operator becomes the owner of all three deployed contracts
///         (and therefore the agent's TEE EOA, which signs trades).
/// @dev    Pattern mirrors how existing v2 contracts are wired (LpVault
///         + LoanBook two-step propose/accept) but in a single tx for
///         operator convenience.
///
///         The operator must approve this factory for at least
///         `registry.bondUsdc6()` USDC before calling `deploy()` — the
///         registry's `register()` pulls bond from msg.sender (the
///         factory), and the factory pre-pulls from the operator.
contract AgentFactory {
    using SafeERC20 for IERC20;

    AgentRegistry public immutable registry;
    IERC20 public immutable usdc;

    /// @notice Parameters bundle. Solidity's stack runs out of variable
    ///         slots in the deploy function without bundling these.
    struct DeployParams {
        // AgentPoolVault
        uint256 maxAumUsdc6;
        // OperationalCap
        address opCapPayee;
        uint256 opCapWeeklyUsdc6;
        bytes32 opCapConstitutionalRef;
        // AgentRegistry
        string name;
        string thesis;
        bytes32 imageDigest;
        uint24 colorRgb;
        bytes32 attestationHash;
    }

    event AgentDeployed(
        uint256 indexed agentId,
        address indexed operator,
        address pool,
        address positionBook,
        address opCap
    );

    error BondPullFailed();

    constructor(AgentRegistry registry_) {
        registry = registry_;
        usdc = registry_.usdc();
    }

    /// @notice Deploy a fresh VANTA. The operator (msg.sender) becomes
    ///         the owner of all three deployed contracts. Returns the
    ///         agentId issued by the registry.
    function deploy(DeployParams calldata p)
        external
        returns (uint256 agentId, address pool, address positionBook, address opCap)
    {
        address operator = msg.sender;
        agentId = registry.count();
        (pool, positionBook, opCap) = _deployTriple(operator, agentId, p);
        _pullBondAndRegister(operator, agentId, pool, positionBook, opCap, p);
        emit AgentDeployed(agentId, operator, pool, positionBook, opCap);
    }

    /// @dev Step 1+2+3 of deploy. Splits the contract instantiation into
    ///      its own scope to release stack slots before the registration
    ///      sub-call (which has many string/bytes32 arguments). Stack-too-
    ///      deep is otherwise unavoidable without `via_ir`.
    function _deployTriple(
        address operator,
        uint256 agentId,
        DeployParams calldata p
    ) internal returns (address pool, address positionBook, address opCap) {
        AgentPoolVault vault = new AgentPoolVault(
            usdc,
            operator,
            agentId,
            p.maxAumUsdc6
        );
        // PositionBook constructor reads vault.agentId(), vault.asset();
        // pair them at deploy.
        PositionBook pb = new PositionBook(vault, operator);
        OperationalCap cap = new OperationalCap(
            usdc,
            agentId,
            p.opCapPayee,
            p.opCapWeeklyUsdc6,
            operator,
            p.opCapConstitutionalRef
        );
        return (address(vault), address(pb), address(cap));
    }

    /// @dev Step 4+5: bond pull + registration. Separate scope so the
    ///      call into registry.register doesn't share stack with the
    ///      contract-deploy locals.
    function _pullBondAndRegister(
        address operator,
        uint256 agentId,
        address pool,
        address positionBook,
        address opCap,
        DeployParams calldata p
    ) internal {
        uint256 bond = registry.bondUsdc6();
        usdc.safeTransferFrom(operator, address(this), bond);
        usdc.forceApprove(address(registry), bond);
        uint256 registeredId = registry.register(
            p.name,
            p.thesis,
            p.imageDigest,
            p.colorRgb,
            pool,
            positionBook,
            opCap,
            p.attestationHash
        );
        require(registeredId == agentId, "AgentFactory: id race");
    }
}
