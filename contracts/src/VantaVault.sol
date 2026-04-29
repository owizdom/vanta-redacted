// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title VantaVault — ERC-1155 holder for pledged Polymarket CTF positions.
/// @notice Holds ERC-1155 tokens transferred in by registered borrower
///         proxies. Admin can release tokens back to a proxy or move them
///         to a liquidation auction.
/// @dev Invariants:
///        - I-VV-1: only registered borrower proxies may transfer tokens
///          INTO the vault. Receiving from anyone else reverts with
///          NotRegisteredBorrower so the CTF cannot be tricked into
///          settling a pledge against a sender we do not recognise.
///        - I-VV-2: receiver hooks return the magic ERC-1155 selector only
///          on the success path. Reverting (rather than returning 0x0)
///          aborts the calling `safeTransferFrom`, leaving the CTF state
///          untouched.
///        - I-VV-3: only admin can release tokens (back to a borrower) or
///          liquidate them (forward to an auction escrow). The vault has
///          no other outflow paths.
///
///      The vault is pinned to a single ERC-1155 token contract — the
///      Polymarket ConditionalTokens (CTF) on Amoy. Mirrors the LpVault
///      pinning of USDC on Base Sepolia. Constructor takes the token
///      address so tests can override it; deploy script forces it to the
///      canonical CTF.
contract VantaVault is ERC1155Holder, Ownable2Step {
    /// @notice The single ERC-1155 token this vault holds (Polymarket CTF
    ///         on Amoy in production).
    IERC1155 public immutable token;

    /// @notice Borrower proxies allowed to push tokens into the vault.
    mapping(address proxy => bool allowed) public borrowerRegistry;

    error NotRegisteredBorrower(address from);
    error AlreadyRegistered(address proxy);
    error NotRegistered(address proxy);

    event BorrowerRegistered(address indexed proxy);
    event BorrowerUnregistered(address indexed proxy);
    event Released(
        address indexed proxy,
        uint256 indexed positionId,
        uint256 amount
    );
    event Liquidated(
        address indexed auctionEscrow,
        uint256 indexed positionId,
        uint256 amount
    );

    constructor(IERC1155 token_, address admin_) Ownable(admin_) {
        token = token_;
    }

    // -----------------------------------------------------------------------
    // Registry — owner-managed
    // -----------------------------------------------------------------------

    function registerBorrower(address proxy) external onlyOwner {
        if (borrowerRegistry[proxy]) revert AlreadyRegistered(proxy);
        borrowerRegistry[proxy] = true;
        emit BorrowerRegistered(proxy);
    }

    function unregisterBorrower(address proxy) external onlyOwner {
        if (!borrowerRegistry[proxy]) revert NotRegistered(proxy);
        borrowerRegistry[proxy] = false;
        emit BorrowerUnregistered(proxy);
    }

    // -----------------------------------------------------------------------
    // Receiver hooks — gate at `from`, not at the token contract
    // -----------------------------------------------------------------------

    /// @inheritdoc ERC1155Holder
    /// @dev I-VV-1, I-VV-2. Reverts if `from` is not a registered borrower.
    ///      The CTF address is not authoritative — `from` is the principal
    ///      who sent the tokens, which is the proxy that pledged.
    function onERC1155Received(
        address operator,
        address from,
        uint256 id,
        uint256 value,
        bytes memory data
    ) public override returns (bytes4) {
        if (!borrowerRegistry[from]) revert NotRegisteredBorrower(from);
        return super.onERC1155Received(operator, from, id, value, data);
    }

    /// @inheritdoc ERC1155Holder
    function onERC1155BatchReceived(
        address operator,
        address from,
        uint256[] memory ids,
        uint256[] memory values,
        bytes memory data
    ) public override returns (bytes4) {
        if (!borrowerRegistry[from]) revert NotRegisteredBorrower(from);
        return super.onERC1155BatchReceived(operator, from, ids, values, data);
    }

    // -----------------------------------------------------------------------
    // Release / liquidate — only admin (I-VV-3)
    // -----------------------------------------------------------------------

    /// @notice Release a pledged position back to its proxy.
    function release(
        address proxy,
        uint256 positionId,
        uint256 amount
    ) external onlyOwner {
        token.safeTransferFrom(address(this), proxy, positionId, amount, "");
        emit Released(proxy, positionId, amount);
    }

    /// @notice Move a pledged position to a liquidation-auction escrow.
    function liquidate(
        address auctionEscrow,
        uint256 positionId,
        uint256 amount
    ) external onlyOwner {
        token.safeTransferFrom(address(this), auctionEscrow, positionId, amount, "");
        emit Liquidated(auctionEscrow, positionId, amount);
    }
}
