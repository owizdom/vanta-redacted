// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {AgentPoolVault} from "../src/AgentPoolVault.sol";
import {PositionBook} from "../src/PositionBook.sol";
import {OperationalCap} from "../src/OperationalCap.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {AgentFactory} from "../src/AgentFactory.sol";

/// MockUsdc that pretends to be at the canonical Base Sepolia USDC
/// address so AgentPoolVault's BadAsset check passes. We deploy the
/// mock, then `vm.etch` its bytecode at the canonical address.
contract MockUsdc is ERC20 {
    constructor() ERC20("Mock USDC", "mUSDC") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function decimals() public pure override returns (uint8) { return 6; }
}

contract AgentV3Test is Test {
    address constant CANON_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    MockUsdc usdc;
    AgentRegistry registry;
    AgentFactory factory;

    address admin = address(0xA11CE);
    address opAlice = address(0x100A);
    address opBob   = address(0x100B);
    address depUser1 = address(0xDEC1);
    address depUser2 = address(0xDEC2);

    uint256 constant BOND = 100_000_000;            // $100 USDC bond
    uint256 constant MAX_AUM = 10_000_000_000;      // $10k AUM cap
    uint256 constant OP_CAP_WEEKLY = 50_000_000;    // $50/week op cap

    function setUp() public {
        // Pin our mock USDC at the canonical Base Sepolia address that
        // AgentPoolVault hard-checks against.
        MockUsdc tmp = new MockUsdc();
        vm.etch(CANON_USDC, address(tmp).code);
        usdc = MockUsdc(CANON_USDC);

        registry = new AgentRegistry(IERC20(CANON_USDC), BOND, admin);
        factory = new AgentFactory(registry);

        // Fund operators with bond + working capital
        usdc.mint(opAlice, 1_000_000_000);
        usdc.mint(opBob,   1_000_000_000);

        // Fund depositors with enough to hit AUM cap
        usdc.mint(depUser1, 50_000_000_000);
        usdc.mint(depUser2, 50_000_000_000);
    }

    // -----------------------------------------------------------------------
    // AgentRegistry: registration + island layout + duplicate-name reject
    // -----------------------------------------------------------------------

    function test_registry_immutables() public view {
        assertEq(address(registry.usdc()), CANON_USDC);
        assertEq(registry.bondUsdc6(), BOND);
        assertEq(registry.owner(), admin);
        assertEq(registry.count(), 0);
    }

    function test_registry_islandOffset_zero_at_origin() public view {
        (int32 x, int32 z) = registry.islandOffsetOf(0);
        assertEq(int256(x), 0);
        assertEq(int256(z), 0);
    }

    function test_registry_islandOffset_first_ring() public view {
        // agentId=1 → N (z=-200). agentId=3 → E (x=+200). agentId=5 → S (z=+200).
        (int32 x1, int32 z1) = registry.islandOffsetOf(1);
        assertEq(int256(z1), -200);
        assertEq(int256(x1), 0);
        (int32 x3, int32 z3) = registry.islandOffsetOf(3);
        assertEq(int256(x3), 200);
        assertEq(int256(z3), 0);
        (int32 x5, int32 z5) = registry.islandOffsetOf(5);
        assertEq(int256(x5), 0);
        assertEq(int256(z5), 200);
    }

    function test_registry_islandOffset_second_ring_radius() public view {
        // agentId=9 is the first agent of ring 2; its radius is 200+180=380.
        (int32 x9, int32 z9) = registry.islandOffsetOf(9);
        assertEq(int256(z9), -380);
        assertEq(int256(x9), 0);
    }

    function test_factory_deploy_first_agent_assigns_id_zero() public {
        (uint256 id, address pool, address pb, address opCap) =
            _deployAgent(opAlice, "vanta-zero", "claude thesis", 0xB464DC);
        assertEq(id, 0);
        assertEq(registry.count(), 1);
        // Triple agentIds match
        assertEq(AgentPoolVault(pool).agentId(), 0);
        assertEq(PositionBook(pb).agentId(), 0);
        assertEq(OperationalCap(opCap).agentId(), 0);
        // Operator is owner of all three
        assertEq(AgentPoolVault(pool).owner(), opAlice);
        assertEq(PositionBook(pb).owner(), opAlice);
        assertEq(OperationalCap(opCap).owner(), opAlice);
        // Registry tracked
        AgentRegistry.Agent memory a = registry.agentOf(id);
        assertEq(a.pool, pool);
        assertEq(a.positionBook, pb);
        assertEq(a.opCap, opCap);
        assertEq(a.colorRgb, 0xB464DC);
        // Bond was pulled
        assertEq(usdc.balanceOf(address(registry)), BOND);
    }

    function test_registry_rejects_duplicate_name_case_insensitive() public {
        _deployAgent(opAlice, "vanta-zero", "thesis a", 0xB464DC);

        // Case-insensitive collision should revert at registry.register.
        // We can't use the helper because vm.expectRevert needs to be
        // immediately before the reverting call; the helper makes
        // multiple calls.
        vm.prank(opBob);
        usdc.approve(address(factory), type(uint256).max);

        AgentFactory.DeployParams memory p = AgentFactory.DeployParams({
            maxAumUsdc6: MAX_AUM,
            opCapPayee: address(0xFEE),
            opCapWeeklyUsdc6: OP_CAP_WEEKLY,
            opCapConstitutionalRef: keccak256("ref"),
            name: "VANTA-ZERO",
            thesis: "thesis b",
            imageDigest: keccak256("d"),
            colorRgb: 0x4FAE5A,
            attestationHash: keccak256("a")
        });
        vm.prank(opBob);
        vm.expectRevert();
        factory.deploy(p);
    }

    // -----------------------------------------------------------------------
    // AgentPoolVault: ERC-4626 deposit/withdraw, AUM cap, inflation protection
    // -----------------------------------------------------------------------

    function test_vault_deposit_and_share_math() public {
        (, address pool,,) = _deployAgent(opAlice, "agent-1", "t", 0xFFFFFF);
        AgentPoolVault vault = AgentPoolVault(pool);

        vm.startPrank(depUser1);
        usdc.approve(pool, type(uint256).max);
        uint256 shares = vault.deposit(1_000_000_000, depUser1); // $1k
        vm.stopPrank();

        // First deposit at no openPositionsValue: 1 USDC = 1 share-unit
        // virtual offset of 6 means shares = USDC * 10^6
        // Inflation protection: virtual share = 10^12 against 1 wei initial.
        // With totalAssets = 1e9 and totalSupply = 1e15 -ish.
        // Easier check: redeem returns same USDC.
        assertEq(vault.balanceOf(depUser1), shares);
        assertGt(shares, 0);
        assertEq(vault.totalAssets(), 1_000_000_000);

        vm.startPrank(depUser1);
        uint256 out = vault.redeem(shares, depUser1, depUser1);
        vm.stopPrank();
        // Round-trip: USDC out should equal USDC in (no slippage in the
        // empty-positions case).
        assertEq(out, 1_000_000_000);
        assertEq(vault.totalAssets(), 0);
    }

    function test_vault_aum_cap_enforced() public {
        (, address pool,,) = _deployAgent(opAlice, "agent-cap", "t", 0xFFFFFF);
        AgentPoolVault vault = AgentPoolVault(pool);

        vm.startPrank(depUser1);
        usdc.approve(pool, type(uint256).max);
        // Deposit up to the cap
        vault.deposit(MAX_AUM, depUser1);
        // maxDeposit returns 0 at-cap
        assertEq(vault.maxDeposit(depUser1), 0);
        // Further deposit reverts
        vm.expectRevert();
        vault.deposit(1, depUser1);
        vm.stopPrank();
    }

    function test_vault_decimalsOffset_inflation_protection() public {
        (, address pool,,) = _deployAgent(opAlice, "agent-inf", "t", 0xFFFFFF);
        AgentPoolVault vault = AgentPoolVault(pool);
        // First deposit at the virtual-share inflation protection. With
        // _decimalsOffset() = 6, ERC4626 mints `assets * 10^6` shares
        // for the first deposit. $1 (1e6 wei) → 1e12 share-units.
        vm.startPrank(depUser1);
        usdc.approve(pool, type(uint256).max);
        vault.deposit(1_000_000, depUser1); // $1
        vm.stopPrank();
        // Donation attack would require the attacker to mint more than
        // 10^12 share-units to dent the share price. Bound is at least
        // 10^11 (10x ratio between deposit wei and shares).
        assertGe(vault.totalSupply(), 10**11);
    }

    // -----------------------------------------------------------------------
    // PositionBook: wiring + open/close lifecycle
    // -----------------------------------------------------------------------

    function test_positionbook_open_close_roundtrip() public {
        (, address pool, address pb,) = _deployAgent(opAlice, "agent-trade", "t", 0xFFFFFF);
        AgentPoolVault vault = AgentPoolVault(pool);
        PositionBook book = PositionBook(pb);

        // Wire vault → positionBook (two-step)
        vm.startPrank(opAlice);
        vault.proposePositionBook(pb);
        book.acceptVaultWiring();
        vm.stopPrank();
        assertEq(vault.positionBook(), pb);

        // Deposit so the vault has USDC to lend the trade
        vm.startPrank(depUser1);
        usdc.approve(pool, type(uint256).max);
        vault.deposit(1_000_000_000, depUser1); // $1k
        vm.stopPrank();
        assertEq(usdc.balanceOf(pool), 1_000_000_000);

        // Open a $100 YES position at 0.18 (1800 bps)
        bytes32 pid = keccak256("position-1");
        bytes32 mkt = keccak256("market-1");
        vm.prank(opAlice);
        book.open(pid, mkt, PositionBook.Side.Yes, 100_000_000, 1800, bytes32(uint256(0xAA)));

        // Vault USDC down by 100, openPositionsValue up by 100 → totalAssets unchanged
        assertEq(usdc.balanceOf(pool), 900_000_000);
        assertEq(vault.openPositionsValueUsdc6(), 100_000_000);
        assertEq(vault.totalAssets(), 1_000_000_000);
        assertEq(book.openNotionalUsdc6(), 100_000_000);
        assertEq(usdc.balanceOf(opAlice), 1_000_000_000 - BOND + 100_000_000);

        // Close at 0.50 (5000 bps) for $277 proceeds (simulating 3x at exit)
        // Operator is also the relayer — funds in operator wallet go back to vault
        vm.startPrank(opAlice);
        usdc.approve(pb, type(uint256).max);
        book.close(pid, 5000, 277_000_000, bytes32(uint256(0xBB)));
        vm.stopPrank();

        // Vault recovered: 900 + 277 = 1177 USDC + 0 open positions
        assertEq(usdc.balanceOf(pool), 1_177_000_000);
        assertEq(vault.openPositionsValueUsdc6(), 0);
        assertEq(vault.totalAssets(), 1_177_000_000);
        assertEq(book.openNotionalUsdc6(), 0);
        assertEq(book.lifetimeProceedsUsdc6(), 277_000_000);
        assertEq(book.lifetimeCostBasisUsdc6(), 100_000_000);
    }

    function test_positionbook_double_open_reverts() public {
        (, address pool, address pb,) = _deployAgent(opAlice, "agent-dup", "t", 0xFFFFFF);
        _wireAndDeposit(opAlice, depUser1, AgentPoolVault(pool), PositionBook(pb), 1_000_000_000);

        bytes32 pid = keccak256("p");
        bytes32 mkt = keccak256("m");
        vm.startPrank(opAlice);
        PositionBook(pb).open(pid, mkt, PositionBook.Side.Yes, 100_000_000, 1800, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(PositionBook.PositionIdInUse.selector, pid));
        PositionBook(pb).open(pid, mkt, PositionBook.Side.Yes, 100_000_000, 1800, bytes32(0));
        vm.stopPrank();
    }

    function test_positionbook_open_only_owner() public {
        (, address pool, address pb,) = _deployAgent(opAlice, "agent-auth", "t", 0xFFFFFF);
        _wireAndDeposit(opAlice, depUser1, AgentPoolVault(pool), PositionBook(pb), 1_000_000_000);
        vm.prank(opBob);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, opBob));
        PositionBook(pb).open(bytes32("x"), bytes32("m"), PositionBook.Side.Yes, 100_000_000, 1800, bytes32(0));
    }

    // -----------------------------------------------------------------------
    // Multi-agent isolation
    // -----------------------------------------------------------------------

    function test_multi_agent_isolation_trades_independent() public {
        // Deploy two agents owned by different operators
        (, address poolA, address pbA,) = _deployAgent(opAlice, "agent-a", "thesis-a", 0xB464DC);
        (, address poolB, address pbB,) = _deployAgent(opBob,   "agent-b", "thesis-b", 0x4FAE5A);
        _wireAndDeposit(opAlice, depUser1, AgentPoolVault(poolA), PositionBook(pbA), 2_000_000_000);
        _wireAndDeposit(opBob,   depUser2, AgentPoolVault(poolB), PositionBook(pbB), 3_000_000_000);

        // Agent A opens a position
        vm.prank(opAlice);
        PositionBook(pbA).open(bytes32("pa"), bytes32("mkt-1"), PositionBook.Side.Yes, 200_000_000, 2500, bytes32(0));

        // Agent B opens a position (same market id, different side, different book)
        vm.prank(opBob);
        PositionBook(pbB).open(bytes32("pb"), bytes32("mkt-1"), PositionBook.Side.No, 500_000_000, 7500, bytes32(0));

        // A's books reflect only its own trade; B's reflects only its own
        assertEq(AgentPoolVault(poolA).openPositionsValueUsdc6(), 200_000_000);
        assertEq(AgentPoolVault(poolB).openPositionsValueUsdc6(), 500_000_000);
        assertEq(PositionBook(pbA).openNotionalUsdc6(), 200_000_000);
        assertEq(PositionBook(pbB).openNotionalUsdc6(), 500_000_000);

        // No cross-write via PositionBook isolation:
        // Bob cannot call A's PositionBook even with A's positionId
        vm.prank(opBob);
        vm.expectRevert();
        PositionBook(pbA).open(bytes32("foreign"), bytes32("mkt-2"), PositionBook.Side.Yes, 100_000_000, 1000, bytes32(0));
    }

    // -----------------------------------------------------------------------
    // OperationalCap: weekly cap enforcement (per-agent isolation)
    // -----------------------------------------------------------------------

    function test_opcap_weekly_cap_enforced() public {
        (,, , address opCap) = _deployAgent(opAlice, "agent-op", "t", 0xFFFFFF);
        OperationalCap cap = OperationalCap(opCap);
        // Operator funds and approves
        vm.prank(opAlice);
        usdc.approve(opCap, type(uint256).max);

        // Pay up to cap
        vm.prank(opAlice);
        cap.pay(OP_CAP_WEEKLY);
        // Next payment in same week reverts
        vm.prank(opAlice);
        vm.expectRevert();
        cap.pay(1);
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    function _deployAgent(
        address operator,
        string memory name,
        string memory thesis,
        uint24 colorRgb
    ) internal returns (uint256 agentId, address pool, address pb, address opCap) {
        // Operator approves factory to pull bond
        vm.prank(operator);
        usdc.approve(address(factory), type(uint256).max);

        AgentFactory.DeployParams memory p = AgentFactory.DeployParams({
            maxAumUsdc6: MAX_AUM,
            opCapPayee: address(0xFEE),
            opCapWeeklyUsdc6: OP_CAP_WEEKLY,
            opCapConstitutionalRef: keccak256("vanta-genesis-sco/op-cap.v3"),
            name: name,
            thesis: thesis,
            imageDigest: keccak256(abi.encodePacked("digest-", name)),
            colorRgb: colorRgb,
            attestationHash: keccak256(abi.encodePacked("att-", name))
        });
        vm.prank(operator);
        (agentId, pool, pb, opCap) = factory.deploy(p);
    }

    function _wireAndDeposit(
        address operator,
        address depositor,
        AgentPoolVault vault,
        PositionBook book,
        uint256 amount
    ) internal {
        vm.startPrank(operator);
        vault.proposePositionBook(address(book));
        book.acceptVaultWiring();
        vm.stopPrank();

        vm.startPrank(depositor);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(amount, depositor);
        vm.stopPrank();
    }
}
