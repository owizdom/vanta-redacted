// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {VendorPayment} from "../src/VendorPayment.sol";

contract MockUsdc is ERC20 {
    constructor() ERC20("Mock USDC", "mUSDC") {}
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

contract VendorPaymentTest is Test {
    MockUsdc usdc;
    VendorPayment vp;

    address admin = address(0xA11CE);
    address treasury = address(0x7E45) ;
    address vendor = address(0xBEEF);
    address attacker = address(0xBAD);

    uint256 constant WEEKLY_CAP = 55_270_000;          // $55.27 in USDC wei
    bytes32 constant CONST_REF =
        keccak256("vanta-genesis-sco/payouts.hosting.weekly.v1");

    function setUp() public {
        usdc = new MockUsdc();
        vp = new VendorPayment(IERC20(address(usdc)), vendor, WEEKLY_CAP, admin, CONST_REF);

        usdc.mint(treasury, 10_000_000_000);          // 10,000 USDC
        vm.prank(treasury);
        usdc.approve(address(vp), type(uint256).max);
    }

    function test_immutables() public view {
        assertEq(address(vp.usdc()), address(usdc));
        assertEq(vp.vendorPayee(), vendor);
        assertEq(vp.weeklyCapUsdc6(), WEEKLY_CAP);
        assertEq(vp.constitutionalRef(), CONST_REF);
        assertEq(vp.owner(), admin);
    }

    function test_constructor_rejects_zero_payee() public {
        vm.expectRevert(VendorPayment.VendorPayeeZero.selector);
        new VendorPayment(IERC20(address(usdc)), address(0), WEEKLY_CAP, admin, CONST_REF);
    }

    function test_constructor_rejects_zero_cap() public {
        vm.expectRevert(VendorPayment.WeeklyCapZero.selector);
        new VendorPayment(IERC20(address(usdc)), vendor, 0, admin, CONST_REF);
    }

    function test_pay_only_owner() public {
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        vp.pay(1_000_000);
    }

    function test_pay_zero_reverts() public {
        vm.startPrank(admin);
        vm.expectRevert(VendorPayment.AmountIsZero.selector);
        vp.pay(0);
        vm.stopPrank();
    }

    function test_pay_pulls_from_owner_caller_to_vendor() public {
        // Owner is the admin; the admin must hold USDC + grant allowance for
        // a real payment. Mirror that flow.
        usdc.mint(admin, 100_000_000);
        vm.prank(admin);
        usdc.approve(address(vp), type(uint256).max);

        vm.prank(admin);
        vp.pay(WEEKLY_CAP);

        assertEq(usdc.balanceOf(vendor), WEEKLY_CAP);
        assertEq(vp.paidThisWeek(block.timestamp / 7 days), WEEKLY_CAP);
    }

    function test_pay_emits_event() public {
        usdc.mint(admin, WEEKLY_CAP);
        vm.prank(admin);
        usdc.approve(address(vp), type(uint256).max);

        uint256 weekId = block.timestamp / 7 days;
        vm.expectEmit(true, false, false, true, address(vp));
        emit VendorPayment.Paid(weekId, WEEKLY_CAP, WEEKLY_CAP, block.timestamp);
        vm.prank(admin);
        vp.pay(WEEKLY_CAP);
    }

    function test_weekly_cap_boundary_exact() public {
        usdc.mint(admin, WEEKLY_CAP);
        vm.prank(admin);
        usdc.approve(address(vp), type(uint256).max);

        // Two payments summing to exactly the cap should both land.
        vm.startPrank(admin);
        vp.pay(WEEKLY_CAP / 2);
        vp.pay(WEEKLY_CAP - WEEKLY_CAP / 2);
        vm.stopPrank();
        assertEq(vp.paidThisWeek(block.timestamp / 7 days), WEEKLY_CAP);
    }

    function test_weekly_cap_boundary_one_over() public {
        usdc.mint(admin, 2 * WEEKLY_CAP);
        vm.prank(admin);
        usdc.approve(address(vp), type(uint256).max);

        vm.startPrank(admin);
        vp.pay(WEEKLY_CAP);
        vm.expectRevert(
            abi.encodeWithSelector(
                VendorPayment.WeeklyCapExceeded.selector,
                block.timestamp / 7 days,
                WEEKLY_CAP,
                1,
                WEEKLY_CAP
            )
        );
        vp.pay(1);
        vm.stopPrank();
    }

    function test_week_rollover_resets_tally() public {
        usdc.mint(admin, 3 * WEEKLY_CAP);
        vm.prank(admin);
        usdc.approve(address(vp), type(uint256).max);

        vm.prank(admin);
        vp.pay(WEEKLY_CAP);
        uint256 priorWeek = block.timestamp / 7 days;
        assertEq(vp.paidThisWeek(priorWeek), WEEKLY_CAP);

        // Advance one week. New window starts at zero.
        vm.warp(block.timestamp + 7 days);
        vm.prank(admin);
        vp.pay(WEEKLY_CAP);
        uint256 newWeek = block.timestamp / 7 days;
        assertGt(newWeek, priorWeek);
        assertEq(vp.paidThisWeek(newWeek), WEEKLY_CAP);
        // Prior week's tally is preserved (audit history).
        assertEq(vp.paidThisWeek(priorWeek), WEEKLY_CAP);
    }

    function test_constitutional_ref_survives_view() public view {
        assertEq(vp.constitutionalRef(), CONST_REF);
    }

    function test_currentWeekId_matches_block_div() public view {
        assertEq(vp.currentWeekId(), block.timestamp / 7 days);
    }

    function test_ownership_transfer_two_step() public {
        address newAdmin = address(0xC0FFEE);
        vm.prank(admin);
        vp.transferOwnership(newAdmin);
        // Ownership not yet transferred — pending only.
        assertEq(vp.owner(), admin);
        assertEq(vp.pendingOwner(), newAdmin);

        vm.prank(newAdmin);
        vp.acceptOwnership();
        assertEq(vp.owner(), newAdmin);
    }
}
