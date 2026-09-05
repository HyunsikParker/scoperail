// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// @notice Scoped admissions for offchain tools. No funds or external execution.
contract ScopeRail {
    struct Grant {
        address owner;
        address delegate;
        bytes32 providerId;
        bytes32 resourceId;
        uint64 validUntil;
        uint32 remaining;
        uint32 maxPerCall;
        uint64 nextNonce;
        bool revoked;
    }

    uint256 public nextGrantId = 1;
    mapping(uint256 => Grant) public grants;

    error InvalidGrant();
    error InvalidConfiguration();
    error NotOwner();
    error NotDelegate();
    error Revoked();
    error Expired();
    error ScopeMismatch();
    error InvalidUnits();
    error BudgetExceeded();
    error NonceMismatch();
    error InvalidCommitment();

    event GrantCreated(
        uint256 indexed grantId, address indexed owner, address indexed delegate,
        bytes32 providerId, bytes32 resourceId, uint64 validUntil,
        uint32 budget, uint32 maxPerCall
    );
    event GrantRevoked(uint256 indexed grantId);
    event Admission(
        bytes32 indexed receiptId, uint256 indexed grantId, uint64 nonce,
        address owner, address delegate, bytes32 providerId, bytes32 resourceId,
        uint32 units, bytes32 requestHash
    );

    function createGrant(
        address delegate, bytes32 providerId, bytes32 resourceId,
        uint64 validUntil, uint32 budget, uint32 maxPerCall
    ) external returns (uint256 grantId) {
        if (delegate == address(0) || providerId == bytes32(0) || resourceId == bytes32(0)
            || validUntil <= block.timestamp || budget == 0 || maxPerCall == 0
            || maxPerCall > budget) revert InvalidConfiguration();
        grantId = nextGrantId++;
        grants[grantId] = Grant({
            owner: msg.sender, delegate: delegate, providerId: providerId,
            resourceId: resourceId, validUntil: validUntil, remaining: budget,
            maxPerCall: maxPerCall, nextNonce: 0, revoked: false
        });
        emit GrantCreated(grantId, msg.sender, delegate, providerId, resourceId,
                          validUntil, budget, maxPerCall);
    }

    function revoke(uint256 grantId) external {
        Grant storage grant = grants[grantId];
        if (grant.owner == address(0)) revert InvalidGrant();
        if (msg.sender != grant.owner) revert NotOwner();
        if (!grant.revoked) {
            grant.revoked = true;
            emit GrantRevoked(grantId);
        }
    }

    function consume(
        uint256 grantId, bytes32 providerId, bytes32 resourceId,
        uint32 units, uint64 expectedNonce, bytes32 requestHash
    ) external returns (bytes32 receiptId) {
        Grant storage grant = grants[grantId];
        if (grant.owner == address(0)) revert InvalidGrant();
        if (msg.sender != grant.delegate) revert NotDelegate();
        if (grant.revoked) revert Revoked();
        if (block.timestamp >= grant.validUntil) revert Expired();
        if (providerId != grant.providerId || resourceId != grant.resourceId) revert ScopeMismatch();
        if (units == 0 || units > grant.maxPerCall) revert InvalidUnits();
        if (units > grant.remaining) revert BudgetExceeded();
        if (expectedNonce != grant.nextNonce) revert NonceMismatch();
        if (requestHash == bytes32(0)) revert InvalidCommitment();

        grant.remaining -= units;
        grant.nextNonce += 1;
        receiptId = keccak256(abi.encode(
            block.chainid, address(this), grantId, expectedNonce, requestHash, units
        ));
        emit Admission(receiptId, grantId, expectedNonce, grant.owner, msg.sender,
                       providerId, resourceId, units, requestHash);
    }
}
