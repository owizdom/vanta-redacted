// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {console2} from "forge-std/console2.sol";

/// @notice Shared base script: chain-id assertion + deployment-JSON read/write.
/// @dev Subclasses call `_assertChain()` at the top of `run()` before any
///      broadcast, and `_writeAddress(...)` after a successful deploy.
abstract contract Common is Script {
    using stdJson for string;

    error WrongChain(uint256 expected, uint256 actual);

    /// @notice Revert if `block.chainid` does not match `expected`.
    function _assertChain(uint256 expected) internal view {
        if (block.chainid != expected) revert WrongChain(expected, block.chainid);
    }

    /// @notice Resolve the deployment JSON path for a given chain label.
    /// @dev `forge script` runs from `contracts/` (foundry.toml `script = "script"`),
    ///      so the relative path is correct. Callers pass labels like
    ///      `"base-sepolia"` or `"amoy"`.
    function _deploymentPath(string memory chainLabel) internal pure returns (string memory) {
        return string.concat("deployments/", chainLabel, ".json");
    }

    /// @notice Read the entire deployment JSON for a chain. Returns `""` if the
    ///         file does not yet exist.
    function _readDeployments(string memory chainLabel) internal view returns (string memory) {
        string memory path = _deploymentPath(chainLabel);
        try vm.readFile(path) returns (string memory content) {
            return content;
        } catch {
            return "";
        }
    }

    /// @notice Read a single address from the deployments JSON for `chainLabel`.
    /// @dev Returns `address(0)` if the key is missing.
    function _readAddress(string memory chainLabel, string memory key) internal returns (address) {
        string memory content = _readDeployments(chainLabel);
        if (bytes(content).length == 0) return address(0);
        string memory selector = string.concat(".", key);
        try vm.parseJsonAddress(content, selector) returns (address a) {
            return a;
        } catch {
            return address(0);
        }
    }

    /// @notice Resolve the origination-admin EOA. Order:
    ///   1. `VANTA_ADMIN` env var (a 20-byte hex address). Used by the
    ///      EigenCompute path: the runtime in the TEE derives its admin
    ///      via HMAC(appId), exposes it via /api/tee, and the operator
    ///      passes that address to the deploy scripts. Deployer never
    ///      needs the admin private key.
    ///   2. Fallback: HKDF-SHA256 against `.vanta/dev-seed` for the
    ///      local-anvil flow where deployer == admin.
    function _deriveAdmin() internal returns (address) {
        try vm.envAddress("VANTA_ADMIN") returns (address envAdmin) {
            if (envAdmin != address(0)) return envAdmin;
        } catch {
            // env var unset / unparseable: fall through
        }
        return _deriveAdminFromDevSeed();
    }

    /// @notice Derive the dev-time origination admin EOA from `.vanta/dev-seed`
    ///         using HKDF-SHA256 with info string `"vanta-origination-eoa"`.
    /// @dev Reads the binary seed file (32 bytes), folds it through one
    ///      HKDF-SHA256 expansion block, and converts the 32-byte secret into
    ///      an EOA via `vm.addr`. The seed file is gitignored under `.vanta/`.
    function _deriveAdminFromDevSeed() internal view returns (address) {
        bytes memory seed = vm.readFileBinary("../.vanta/dev-seed");
        require(seed.length == 32, "dev-seed: expected 32 bytes");
        bytes32 sk = _hkdfSha256(seed, bytes(""), bytes("vanta-origination-eoa"));
        return vm.addr(uint256(sk));
    }

    /// @dev Standard HKDF-SHA256 (RFC 5869), L=32. PRK = HMAC(salt, IKM);
    ///      OKM_1 = HMAC(PRK, info || 0x01). One-block expansion is enough
    ///      for L=32 since SHA-256 emits 32 bytes per block.
    function _hkdfSha256(
        bytes memory ikm,
        bytes memory salt,
        bytes memory info
    ) internal pure returns (bytes32) {
        bytes32 prk = _hmacSha256(salt, ikm);
        bytes memory infoCtr = abi.encodePacked(info, bytes1(0x01));
        return _hmacSha256(abi.encodePacked(prk), infoCtr);
    }

    /// @dev HMAC-SHA256, RFC 2104. Block size = 64 bytes.
    function _hmacSha256(bytes memory key, bytes memory msgIn) internal pure returns (bytes32) {
        bytes memory k0 = new bytes(64);
        if (key.length > 64) {
            bytes32 h = sha256(key);
            for (uint256 i = 0; i < 32; i++) k0[i] = h[i];
        } else {
            for (uint256 i = 0; i < key.length; i++) k0[i] = key[i];
        }
        bytes memory ipad = new bytes(64);
        bytes memory opad = new bytes(64);
        for (uint256 i = 0; i < 64; i++) {
            ipad[i] = bytes1(uint8(k0[i]) ^ 0x36);
            opad[i] = bytes1(uint8(k0[i]) ^ 0x5c);
        }
        bytes32 inner = sha256(abi.encodePacked(ipad, msgIn));
        return sha256(abi.encodePacked(opad, inner));
    }

    /// @notice Write `key = value` into `deployments/<chainLabel>.json`.
    /// @dev Read-modify-write: existing keys are preserved. The `chain`
    ///      and `chainId` fields are always re-stamped.
    function _writeAddress(
        string memory chainLabel,
        uint256 chainId,
        string memory key,
        address value
    ) internal {
        string memory path = _deploymentPath(chainLabel);
        string memory existing = _readDeployments(chainLabel);

        // Build the output object. We stash existing addresses by re-reading
        // each known key; vm.serializeAddress accumulates into a single object.
        string memory obj = "deploy";
        vm.serializeString(obj, "chain", chainLabel);
        vm.serializeUint(obj, "chainId", chainId);

        // Preserve every prior address key by re-emitting it.
        string[5] memory knownKeys = [
            "LpVault",
            "LoanBook",
            "VantaVault",
            "VendorPaymentHosting",
            "VendorPaymentInference"
        ];
        for (uint256 i = 0; i < knownKeys.length; i++) {
            if (keccak256(bytes(knownKeys[i])) == keccak256(bytes(key))) continue;
            if (bytes(existing).length == 0) continue;
            string memory selector = string.concat(".", knownKeys[i]);
            try vm.parseJsonAddress(existing, selector) returns (address prior) {
                if (prior != address(0)) vm.serializeAddress(obj, knownKeys[i], prior);
            } catch {
                // missing key; skip
            }
        }

        // Stamp the new key last; result is the serialized JSON string.
        string memory finalJson = vm.serializeAddress(obj, key, value);
        vm.writeFile(path, finalJson);
        console2.log("wrote deployment:", path);
        console2.log("  ", key, "=", value);
    }
}
