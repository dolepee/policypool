// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IPolicyRegistryView {
    function policyProvider(bytes32 policyId) external view returns (address);
    function policyPayoutBasis(bytes32 policyId) external view returns (uint8);
    function policyClock(bytes32 policyId) external view returns (uint8 clockMode, uint32 slaSeconds);
    function policyCoverageLimits(bytes32 policyId)
        external
        view
        returns (uint128 maxCapAtomic, uint32 enrollmentWindowSeconds);
    function isCoverable(bytes32 policyId, bytes32 observedFingerprint) external view returns (bool);
}

interface IProviderBondManager {
    function lock(bytes32 covenantId, address provider, uint256 amount) external;
    function release(bytes32 covenantId) external;
    function slash(bytes32 covenantId, address recipient, uint256 payout) external;
}

/// @notice Provider-first-loss covenant lifecycle for objectively verifiable agent jobs.
/// @dev An operator can mark a breach, but payout requires final recovery evidence so
///      marketplace refunds cannot be stacked with the full coverage cap.
contract CoverageManager {
    error Unauthorized();
    error ZeroAddress();
    error InvalidCovenant();
    error CovenantAlreadyExists();
    error JobAlreadyCovered();
    error CovenantNotActive();
    error DeadlineNotElapsed();
    error PolicyNotCoverable();
    error ProviderMismatch();
    error RecoveryEvidenceRequired();

    enum CovenantState {
        None,
        PendingStart,
        Active,
        Released,
        PayoutDue,
        Paid,
        RecoveredWithoutPayout
    }

    struct Covenant {
        bytes32 id;
        bytes32 policyId;
        bytes32 jobId;
        address provider;
        address buyer;
        uint128 coverageCapAtomic;
        uint128 buyerPaidAtomic;
        uint64 issuedAt;
        uint64 startAt;
        uint64 deadline;
        uint64 enrollmentExpiresAt;
        uint32 slaSeconds;
        uint8 payoutBasis;
        uint8 clockMode;
        CovenantState state;
        uint128 payoutAtomic;
        bytes32 recoveryEvidenceHash;
    }

    IPolicyRegistryView public immutable policyRegistry;
    IProviderBondManager public immutable bondVault;
    address public owner;
    address public pendingOwner;
    address public operator;

    mapping(bytes32 covenantId => Covenant covenant) private covenants;
    mapping(bytes32 jobId => bytes32 covenantId) public coveredJobCovenant;

    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OperatorUpdated(address indexed previousOperator, address indexed newOperator);
    event CovenantIssued(
        bytes32 indexed covenantId,
        bytes32 indexed policyId,
        bytes32 indexed jobId,
        address provider,
        address buyer,
        uint256 coverageCapAtomic,
        uint256 buyerPaidAtomic,
        uint256 deadline,
        uint8 payoutBasis,
        uint8 clockMode
    );
    event CovenantClockStarted(bytes32 indexed covenantId, uint256 startedAt, uint256 deadline, bytes32 evidenceHash);
    event CovenantReleased(bytes32 indexed covenantId, bytes32 reason);
    event CovenantPayoutDue(bytes32 indexed covenantId, bytes32 breachEvidenceHash);
    event CovenantSettled(
        bytes32 indexed covenantId,
        uint256 payoutAtomic,
        uint256 escrowRefundAtomic,
        uint256 otherRecoveryAtomic,
        bytes32 recoveryEvidenceHash,
        CovenantState finalState
    );

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert Unauthorized();
        _;
    }

    constructor(address policyRegistry_, address bondVault_, address owner_) {
        if (policyRegistry_ == address(0) || bondVault_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        policyRegistry = IPolicyRegistryView(policyRegistry_);
        bondVault = IProviderBondManager(bondVault_);
        owner = owner_;
        operator = owner_;
        emit OwnershipTransferred(address(0), owner_);
        emit OperatorUpdated(address(0), owner_);
    }

    function getCovenant(bytes32 covenantId_) external view returns (Covenant memory) {
        return covenants[covenantId_];
    }

    function covenantId(bytes32 policyId, bytes32 jobId, address buyer) public pure returns (bytes32) {
        return keccak256(abi.encode(policyId, jobId, buyer));
    }

    function issue(
        bytes32 policyId,
        bytes32 observedFingerprint,
        bytes32 jobId,
        address provider,
        address buyer,
        uint128 coverageCapAtomic,
        uint128 buyerPaidAtomic,
        uint64 verifiedAcceptanceAt,
        uint64 enrollmentExpiresAt
    ) external onlyOperator returns (bytes32 id) {
        if (provider == address(0) || buyer == address(0)) revert ZeroAddress();
        if (
            policyId == bytes32(0) || observedFingerprint == bytes32(0) || jobId == bytes32(0) || coverageCapAtomic == 0
                || buyerPaidAtomic == 0 || coverageCapAtomic > buyerPaidAtomic || verifiedAcceptanceAt == 0
                || verifiedAcceptanceAt > block.timestamp || enrollmentExpiresAt <= block.timestamp
        ) revert InvalidCovenant();
        (uint8 payoutBasis, uint8 clockMode, uint32 slaSeconds) = _validatePolicyLimits(
            policyId, observedFingerprint, provider, coverageCapAtomic, verifiedAcceptanceAt, enrollmentExpiresAt
        );
        uint64 deadline = clockMode == 0 ? verifiedAcceptanceAt + slaSeconds : 0;
        if (clockMode == 0 && deadline <= block.timestamp) revert InvalidCovenant();

        id = covenantId(policyId, jobId, buyer);
        if (covenants[id].state != CovenantState.None) revert CovenantAlreadyExists();
        _claimJobCoverage(jobId, id);
        bondVault.lock(id, provider, coverageCapAtomic);
        covenants[id] = Covenant({
            id: id,
            policyId: policyId,
            jobId: jobId,
            provider: provider,
            buyer: buyer,
            coverageCapAtomic: coverageCapAtomic,
            buyerPaidAtomic: buyerPaidAtomic,
            issuedAt: uint64(block.timestamp),
            startAt: clockMode == 0 ? verifiedAcceptanceAt : 0,
            deadline: deadline,
            enrollmentExpiresAt: enrollmentExpiresAt,
            slaSeconds: slaSeconds,
            payoutBasis: payoutBasis,
            clockMode: clockMode,
            state: clockMode == 0 ? CovenantState.Active : CovenantState.PendingStart,
            payoutAtomic: 0,
            recoveryEvidenceHash: bytes32(0)
        });
        emit CovenantIssued(
            id, policyId, jobId, provider, buyer, coverageCapAtomic, buyerPaidAtomic, deadline, payoutBasis, clockMode
        );
    }

    function _claimJobCoverage(bytes32 jobId, bytes32 id) private {
        if (coveredJobCovenant[jobId] != bytes32(0)) revert JobAlreadyCovered();
        coveredJobCovenant[jobId] = id;
    }

    function _validatePolicyLimits(
        bytes32 policyId,
        bytes32 observedFingerprint,
        address provider,
        uint128 coverageCapAtomic,
        uint64 verifiedAcceptanceAt,
        uint64 enrollmentExpiresAt
    ) private view returns (uint8 payoutBasis, uint8 clockMode, uint32 slaSeconds) {
        if (policyRegistry.policyProvider(policyId) != provider) revert ProviderMismatch();
        if (!policyRegistry.isCoverable(policyId, observedFingerprint)) revert PolicyNotCoverable();
        payoutBasis = policyRegistry.policyPayoutBasis(policyId);
        (clockMode, slaSeconds) = policyRegistry.policyClock(policyId);
        (uint128 policyMaxCapAtomic, uint32 enrollmentWindowSeconds) = policyRegistry.policyCoverageLimits(policyId);
        if (
            payoutBasis > 1 || clockMode > 1 || slaSeconds == 0 || coverageCapAtomic > policyMaxCapAtomic
                || enrollmentWindowSeconds == 0
                || uint256(enrollmentExpiresAt) != uint256(verifiedAcceptanceAt) + enrollmentWindowSeconds
        ) revert InvalidCovenant();
    }

    function startClock(bytes32 id, uint64 startedAt, bytes32 evidenceHash) external onlyOperator {
        Covenant storage covenant = covenants[id];
        if (covenant.state != CovenantState.PendingStart) revert CovenantNotActive();
        if (
            startedAt < covenant.issuedAt || startedAt > block.timestamp
                || block.timestamp > covenant.enrollmentExpiresAt || evidenceHash == bytes32(0)
        ) revert InvalidCovenant();
        covenant.startAt = startedAt;
        covenant.deadline = startedAt + covenant.slaSeconds;
        covenant.state = CovenantState.Active;
        emit CovenantClockStarted(id, startedAt, covenant.deadline, evidenceHash);
    }

    function expireUnstarted(bytes32 id) external {
        Covenant storage covenant = covenants[id];
        if (covenant.state != CovenantState.PendingStart) revert CovenantNotActive();
        if (block.timestamp <= covenant.enrollmentExpiresAt) revert DeadlineNotElapsed();
        covenant.state = CovenantState.Released;
        bondVault.release(id);
        emit CovenantReleased(id, keccak256("COVERAGE_CLOCK_NOT_STARTED"));
    }

    function release(bytes32 id, bytes32 reason) external onlyOperator {
        Covenant storage covenant = covenants[id];
        if (covenant.state != CovenantState.Active && covenant.state != CovenantState.PendingStart) {
            revert CovenantNotActive();
        }
        covenant.state = CovenantState.Released;
        bondVault.release(id);
        emit CovenantReleased(id, reason);
    }

    function markPayoutDue(bytes32 id, bytes32 breachEvidenceHash) external onlyOperator {
        Covenant storage covenant = covenants[id];
        if (covenant.state != CovenantState.Active) revert CovenantNotActive();
        if (block.timestamp <= covenant.deadline) revert DeadlineNotElapsed();
        if (breachEvidenceHash == bytes32(0)) revert InvalidCovenant();
        covenant.state = CovenantState.PayoutDue;
        emit CovenantPayoutDue(id, breachEvidenceHash);
    }

    function settleNetLoss(
        bytes32 id,
        uint128 escrowRefundAtomic,
        uint128 otherRecoveryAtomic,
        bytes32 recoveryEvidenceHash
    ) external onlyOperator returns (uint256 payoutAtomic) {
        Covenant storage covenant = covenants[id];
        if (covenant.state != CovenantState.PayoutDue) revert CovenantNotActive();
        if (recoveryEvidenceHash == bytes32(0)) revert RecoveryEvidenceRequired();
        covenant.recoveryEvidenceHash = recoveryEvidenceHash;

        uint256 recovered = uint256(escrowRefundAtomic) + uint256(otherRecoveryAtomic);
        if (covenant.payoutBasis == 1) {
            // A provider-funded SLA credit is an explicit liquidated service
            // consequence, not indemnification from the shared reserve.
            payoutAtomic = covenant.coverageCapAtomic;
        } else {
            uint256 netLoss =
                uint256(covenant.buyerPaidAtomic) > recovered ? uint256(covenant.buyerPaidAtomic) - recovered : 0;
            payoutAtomic = netLoss < covenant.coverageCapAtomic ? netLoss : covenant.coverageCapAtomic;
        }
        covenant.payoutAtomic = uint128(payoutAtomic);
        if (payoutAtomic == 0) {
            covenant.state = CovenantState.RecoveredWithoutPayout;
            bondVault.release(id);
        } else {
            covenant.state = CovenantState.Paid;
            bondVault.slash(id, covenant.buyer, payoutAtomic);
        }
        emit CovenantSettled(
            id, payoutAtomic, escrowRefundAtomic, otherRecoveryAtomic, recoveryEvidenceHash, covenant.state
        );
    }

    function setOperator(address nextOperator) external onlyOwner {
        if (nextOperator == address(0)) revert ZeroAddress();
        address previous = operator;
        operator = nextOperator;
        emit OperatorUpdated(previous, nextOperator);
    }

    function transferOwnership(address nextOwner) external onlyOwner {
        if (nextOwner == address(0)) revert ZeroAddress();
        pendingOwner = nextOwner;
        emit OwnershipTransferStarted(owner, nextOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert Unauthorized();
        address previous = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(previous, msg.sender);
    }
}
