// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {console2} from "forge-std/console2.sol";

import {Common} from "./Common.s.sol";
import {VendorPayment} from "../src/VendorPayment.sol";

/// @notice Deploy a VendorPayment instance pinned to a single bucket
///         (hosting | inference). Run once per vendor.
///
/// Required env:
///   DEPLOYER_PRIVATE_KEY  — funded EOA that broadcasts the deploy tx
///   VENDORPAYMENT_BUCKET  — "hosting" or "inference" (controls JSON key)
///   VENDORPAYMENT_PAYEE   — vendor wallet receiving the weekly USDC stream
///                           (typically VANTA_OPERATOR_ADDRESS)
///   VENDORPAYMENT_CAP_USDC6     — weekly cap in USDC wei (6 decimals)
///   VENDORPAYMENT_CONST_REF     — bytes32 hex (0x…) constitutional ref
///
/// Optional:
///   VANTA_TREASURY        — explicit treasury EOA (Ownable owner). When set
///                           overrides the dev-seed fallback. The runtime
///                           exposes this via /api/tee in production.
contract DeployVendorPayment is Common {
    address public constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    string  internal constant CHAIN_LABEL = "local-base-sepolia";
    uint256 internal constant CHAIN_ID = 84532;

    error UnknownBucket(string bucket);
    error TreasuryUnset();

    function run() external {
        _assertChain(CHAIN_ID);

        string memory bucket = vm.envString("VENDORPAYMENT_BUCKET");
        bytes32 bk = keccak256(bytes(bucket));
        string memory key;
        if (bk == keccak256(bytes("hosting"))) {
            key = "VendorPaymentHosting";
        } else if (bk == keccak256(bytes("inference"))) {
            key = "VendorPaymentInference";
        } else {
            revert UnknownBucket(bucket);
        }

        address payee = vm.envAddress("VENDORPAYMENT_PAYEE");
        uint256 cap = vm.envUint("VENDORPAYMENT_CAP_USDC6");
        bytes32 ref = vm.envBytes32("VENDORPAYMENT_CONST_REF");

        // Owner is the treasury EOA — it's the entity that calls pay().
        // Falls back to dev-seed admin for local-anvil flows where
        // deployer == admin == treasury (rare in practice; production
        // always sets VANTA_TREASURY explicitly).
        address treasury;
        try vm.envAddress("VANTA_TREASURY") returns (address t) {
            treasury = t;
        } catch {
            treasury = address(0);
        }
        if (treasury == address(0)) {
            // Dev-seed fallback: same address as admin in local-anvil flow.
            treasury = _deriveAdmin();
            console2.log("VANTA_TREASURY unset; using admin EOA:", treasury);
        }
        if (treasury == address(0)) revert TreasuryUnset();

        console2.log("bucket:        ", bucket);
        console2.log("usdc:          ", USDC);
        console2.log("vendor payee:  ", payee);
        console2.log("weekly cap:    ", cap);
        console2.log("treasury owner:", treasury);
        console2.logBytes32(ref);

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(deployerKey);
        VendorPayment vp = new VendorPayment(
            IERC20(USDC),
            payee,
            cap,
            treasury,
            ref
        );
        vm.stopBroadcast();

        console2.log("VendorPayment deployed at:", address(vp));
        _writeAddress(CHAIN_LABEL, CHAIN_ID, key, address(vp));
    }
}
