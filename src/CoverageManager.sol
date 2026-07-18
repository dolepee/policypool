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

interface ICoverageEvidenceVerifier {
    function verify(bytes32 action, bytes32 payloadHash, bytes[] calldata signatures)
        external
        view
        returns (bytes32 digest);
    function attestationDigest(address manager, bytes32 action, bytes32 payloadHash) external view returns (bytes32);
    function threshold() external view returns (uint8);
    function signerCount() external view returns (uint256);
    function signerAt(uint256 index) external view returns (address);
    function isSigner(address signer) external view returns (bool);
}

/// @notice Provider-first-loss covenant lifecycle for objectively verifiable agent jobs.
/// @dev Every subjective lifecycle fact requires an immutable evidence-signer quorum.
///      Execution is permissionless; no owner or relayer can bypass evidence verification.
contract CoverageManager {
    error ZeroAddress();
    error InvalidCovenant();
    error CovenantAlreadyExists();
    error JobAlreadyCovered();
    error CovenantNotActive();
    error DeadlineNotElapsed();
    error PolicyNotCoverable();
    error ProviderMismatch();
    error RecoveryEvidenceRequired();
    error RecoveryNotFinal();
    error EvidenceStale();
    error EvidenceAlreadyConsumed();
    error EmergencyResolutionNotReady();
    error EvidenceVerifierCollision();
    error EvidenceTopologyInvalid();
    error EvidenceSignerOverlap();
    error SettlementChallengeActive();
    error PaymentAuthorizationActive();
    error PaymentAuthorizationMismatch();
    error Reentrancy();

    uint256 public constant SETTLEMENT_EVIDENCE_MAX_AGE = 10 minutes;
    uint256 public constant CANCELLATION_EVIDENCE_MAX_AGE = 10 minutes;
    uint256 public constant MAX_FEE_AUTHORIZATION_WINDOW = 15 minutes;
    uint256 public constant CLOCK_START_RECOVERY_PERIOD = 10 minutes;
    uint256 public constant SETTLEMENT_CHALLENGE_PERIOD = 24 hours;
    uint256 public constant EMERGENCY_EVIDENCE_DELAY = 30 days;
    uint256 public constant REQUIRED_EVIDENCE_SIGNERS = 5;
    uint256 public constant REQUIRED_EVIDENCE_THRESHOLD = 3;

    bytes32 public constant ISSUE_ACTION = keccak256("POLICYPOOL_ISSUE");
    bytes32 public constant START_CLOCK_ACTION = keccak256("POLICYPOOL_START_CLOCK");
    bytes32 public constant RELEASE_ACTION = keccak256("POLICYPOOL_RELEASE");
    bytes32 public constant BREACH_ACTION = keccak256("POLICYPOOL_BREACH");
    bytes32 public constant SETTLEMENT_ACTION = keccak256("POLICYPOOL_SETTLEMENT");
    bytes32 public constant CANCEL_UNPAID_ACTION = keccak256("POLICYPOOL_CANCEL_UNPAID");

    bytes32 public constant ISSUE_EVIDENCE_TYPEHASH = keccak256(
        "IssueEvidence(bytes32 policyId,bytes32 observedFingerprint,bytes32 jobId,address provider,address buyer,uint128 coverageCapAtomic,uint128 buyerPaidAtomic,uint64 verifiedAcceptanceAt,uint64 enrollmentExpiresAt,bytes32 acceptanceEvidenceHash,FeeAuthorization feeAuthorization)FeeAuthorization(bytes32 authorizationHash,uint64 validBefore)"
    );
    bytes32 public constant FEE_AUTHORIZATION_TYPEHASH =
        keccak256("FeeAuthorization(bytes32 authorizationHash,uint64 validBefore)");
    bytes32 public constant CLOCK_EVIDENCE_TYPEHASH =
        keccak256("ClockEvidence(bytes32 covenantId,uint64 startedAt,bytes32 evidenceHash)");
    bytes32 public constant RELEASE_EVIDENCE_TYPEHASH =
        keccak256("ReleaseEvidence(bytes32 covenantId,uint64 completedAt,uint64 observedAt,bytes32 evidenceHash)");
    bytes32 public constant BREACH_EVIDENCE_TYPEHASH =
        keccak256("BreachEvidence(bytes32 covenantId,uint64 observedAt,bytes32 evidenceHash)");
    bytes32 public constant SETTLEMENT_EVIDENCE_TYPEHASH = keccak256(
        "SettlementEvidence(bytes32 covenantId,uint128 escrowRefundAtomic,uint128 otherRecoveryAtomic,uint64 observedAt,bool recoveryFinalized,bytes32 recoveryEvidenceHash)"
    );
    bytes32 public constant CANCEL_UNPAID_EVIDENCE_TYPEHASH = keccak256(
        "CancelUnpaidEvidence(bytes32 covenantId,uint64 observedAt,bytes32 feeAuthorizationHash,bytes32 nonSettlementEvidenceHash)"
    );

    enum CovenantState {
        None,
        PendingStart,
        Active,
        Released,
        PayoutDue,
        Paid,
        RecoveredWithoutPayout,
        CancelledUnpaid
    }

    struct FeeAuthorization {
        bytes32 authorizationHash;
        uint64 validBefore;
    }

    struct IssueEvidence {
        bytes32 policyId;
        bytes32 observedFingerprint;
        bytes32 jobId;
        address provider;
        address buyer;
        uint128 coverageCapAtomic;
        uint128 buyerPaidAtomic;
        uint64 verifiedAcceptanceAt;
        uint64 enrollmentExpiresAt;
        bytes32 acceptanceEvidenceHash;
        FeeAuthorization feeAuthorization;
    }

    struct ClockEvidence {
        bytes32 covenantId;
        uint64 startedAt;
        bytes32 evidenceHash;
    }

    struct ReleaseEvidence {
        bytes32 covenantId;
        uint64 completedAt;
        uint64 observedAt;
        bytes32 evidenceHash;
    }

    struct BreachEvidence {
        bytes32 covenantId;
        uint64 observedAt;
        bytes32 evidenceHash;
    }

    struct SettlementEvidence {
        bytes32 covenantId;
        uint128 escrowRefundAtomic;
        uint128 otherRecoveryAtomic;
        uint64 observedAt;
        bool recoveryFinalized;
        bytes32 recoveryEvidenceHash;
    }

    struct CancelUnpaidEvidence {
        bytes32 covenantId;
        uint64 observedAt;
        bytes32 feeAuthorizationHash;
        bytes32 nonSettlementEvidenceHash;
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
        uint64 payoutDueAt;
        uint64 completedAt;
        uint64 recoveryObservedAt;
        uint32 slaSeconds;
        uint8 payoutBasis;
        uint8 clockMode;
        CovenantState state;
        uint128 payoutAtomic;
        bytes32 acceptanceEvidenceHash;
        bytes32 breachEvidenceHash;
        bytes32 recoveryEvidenceHash;
        bytes32 feeAuthorizationHash;
        uint64 feeAuthorizationValidBefore;
        bool recoveryFinalized;
    }

    IPolicyRegistryView public immutable policyRegistry;
    IProviderBondManager public immutable bondVault;
    ICoverageEvidenceVerifier public immutable evidenceVerifier;
    ICoverageEvidenceVerifier public immutable recoveryEvidenceVerifier;

    mapping(bytes32 covenantId => Covenant covenant) private covenants;
    mapping(bytes32 jobId => bytes32 covenantId) public coveredJobCovenant;
    mapping(bytes32 evidenceDigest => bool consumed) public consumedEvidenceDigest;

    uint256 private entered = 1;

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
        uint8 clockMode,
        bytes32 acceptanceEvidenceHash,
        bytes32 feeAuthorizationHash,
        uint256 feeAuthorizationValidBefore,
        bytes32 evidenceDigest
    );
    event CovenantClockStarted(
        bytes32 indexed covenantId, uint256 startedAt, uint256 deadline, bytes32 evidenceHash, bytes32 evidenceDigest
    );
    event CovenantReleased(
        bytes32 indexed covenantId,
        uint256 completedAt,
        uint256 observedAt,
        bytes32 evidenceHash,
        bytes32 evidenceDigest
    );
    event CovenantPayoutDue(
        bytes32 indexed covenantId, uint256 observedAt, bytes32 breachEvidenceHash, bytes32 evidenceDigest
    );
    event CovenantSettled(
        bytes32 indexed covenantId,
        uint256 payoutAtomic,
        uint256 escrowRefundAtomic,
        uint256 otherRecoveryAtomic,
        uint256 recoveryObservedAt,
        bool recoveryFinalized,
        bytes32 recoveryEvidenceHash,
        bytes32 evidenceDigest,
        CovenantState finalState
    );
    event CovenantCancelledUnpaid(
        bytes32 indexed covenantId,
        uint256 observedAt,
        bytes32 feeAuthorizationHash,
        bytes32 nonSettlementEvidenceHash,
        bytes32 evidenceDigest
    );
    event EmergencyEvidenceUsed(
        bytes32 indexed covenantId, bytes32 indexed action, address indexed verifier, bytes32 evidenceDigest
    );

    modifier nonReentrant() {
        if (entered != 1) revert Reentrancy();
        entered = 2;
        _;
        entered = 1;
    }

    constructor(
        address policyRegistry_,
        address bondVault_,
        address evidenceVerifier_,
        address recoveryEvidenceVerifier_
    ) {
        if (
            policyRegistry_ == address(0) || bondVault_ == address(0) || evidenceVerifier_ == address(0)
                || recoveryEvidenceVerifier_ == address(0)
        ) {
            revert ZeroAddress();
        }
        if (evidenceVerifier_ == recoveryEvidenceVerifier_) revert EvidenceVerifierCollision();
        policyRegistry = IPolicyRegistryView(policyRegistry_);
        bondVault = IProviderBondManager(bondVault_);
        evidenceVerifier = ICoverageEvidenceVerifier(evidenceVerifier_);
        recoveryEvidenceVerifier = ICoverageEvidenceVerifier(recoveryEvidenceVerifier_);
        _validateEvidenceTopology();
    }

    function getCovenant(bytes32 covenantId_) external view returns (Covenant memory) {
        return covenants[covenantId_];
    }

    function covenantId(bytes32 policyId, bytes32 jobId, address buyer, bytes32 feeAuthorizationHash)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(policyId, jobId, buyer, feeAuthorizationHash));
    }

    function hashIssueEvidence(IssueEvidence memory evidence) public pure returns (bytes32) {
        bytes32 feeAuthorizationHash = keccak256(
            abi.encode(
                FEE_AUTHORIZATION_TYPEHASH,
                evidence.feeAuthorization.authorizationHash,
                evidence.feeAuthorization.validBefore
            )
        );
        return keccak256(
            abi.encode(
                ISSUE_EVIDENCE_TYPEHASH,
                evidence.policyId,
                evidence.observedFingerprint,
                evidence.jobId,
                evidence.provider,
                evidence.buyer,
                evidence.coverageCapAtomic,
                evidence.buyerPaidAtomic,
                evidence.verifiedAcceptanceAt,
                evidence.enrollmentExpiresAt,
                evidence.acceptanceEvidenceHash,
                feeAuthorizationHash
            )
        );
    }

    function hashClockEvidence(ClockEvidence memory evidence) public pure returns (bytes32) {
        return
            keccak256(
                abi.encode(CLOCK_EVIDENCE_TYPEHASH, evidence.covenantId, evidence.startedAt, evidence.evidenceHash)
            );
    }

    function hashReleaseEvidence(ReleaseEvidence memory evidence) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                RELEASE_EVIDENCE_TYPEHASH,
                evidence.covenantId,
                evidence.completedAt,
                evidence.observedAt,
                evidence.evidenceHash
            )
        );
    }

    function hashBreachEvidence(BreachEvidence memory evidence) public pure returns (bytes32) {
        return keccak256(
            abi.encode(BREACH_EVIDENCE_TYPEHASH, evidence.covenantId, evidence.observedAt, evidence.evidenceHash)
        );
    }

    function hashSettlementEvidence(SettlementEvidence memory evidence) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                SETTLEMENT_EVIDENCE_TYPEHASH,
                evidence.covenantId,
                evidence.escrowRefundAtomic,
                evidence.otherRecoveryAtomic,
                evidence.observedAt,
                evidence.recoveryFinalized,
                evidence.recoveryEvidenceHash
            )
        );
    }

    function hashCancelUnpaidEvidence(CancelUnpaidEvidence memory evidence) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                CANCEL_UNPAID_EVIDENCE_TYPEHASH,
                evidence.covenantId,
                evidence.observedAt,
                evidence.feeAuthorizationHash,
                evidence.nonSettlementEvidenceHash
            )
        );
    }

    function issueEvidenceDigest(IssueEvidence calldata evidence) external view returns (bytes32) {
        return evidenceVerifier.attestationDigest(address(this), ISSUE_ACTION, hashIssueEvidence(evidence));
    }

    function clockEvidenceDigest(ClockEvidence calldata evidence) external view returns (bytes32) {
        return evidenceVerifier.attestationDigest(address(this), START_CLOCK_ACTION, hashClockEvidence(evidence));
    }

    function releaseEvidenceDigest(ReleaseEvidence calldata evidence) external view returns (bytes32) {
        return evidenceVerifier.attestationDigest(address(this), RELEASE_ACTION, hashReleaseEvidence(evidence));
    }

    function breachEvidenceDigest(BreachEvidence calldata evidence) external view returns (bytes32) {
        return evidenceVerifier.attestationDigest(address(this), BREACH_ACTION, hashBreachEvidence(evidence));
    }

    function settlementEvidenceDigest(SettlementEvidence calldata evidence) external view returns (bytes32) {
        return evidenceVerifier.attestationDigest(address(this), SETTLEMENT_ACTION, hashSettlementEvidence(evidence));
    }

    function cancelUnpaidEvidenceDigest(CancelUnpaidEvidence calldata evidence) external view returns (bytes32) {
        return
            evidenceVerifier.attestationDigest(address(this), CANCEL_UNPAID_ACTION, hashCancelUnpaidEvidence(evidence));
    }

    function emergencyReleaseEvidenceDigest(ReleaseEvidence calldata evidence) external view returns (bytes32) {
        return recoveryEvidenceVerifier.attestationDigest(address(this), RELEASE_ACTION, hashReleaseEvidence(evidence));
    }

    function emergencyBreachEvidenceDigest(BreachEvidence calldata evidence) external view returns (bytes32) {
        return recoveryEvidenceVerifier.attestationDigest(address(this), BREACH_ACTION, hashBreachEvidence(evidence));
    }

    function emergencySettlementEvidenceDigest(SettlementEvidence calldata evidence) external view returns (bytes32) {
        return
            recoveryEvidenceVerifier.attestationDigest(
                address(this), SETTLEMENT_ACTION, hashSettlementEvidence(evidence)
            );
    }

    function emergencyCancelUnpaidEvidenceDigest(CancelUnpaidEvidence calldata evidence)
        external
        view
        returns (bytes32)
    {
        return recoveryEvidenceVerifier.attestationDigest(
            address(this), CANCEL_UNPAID_ACTION, hashCancelUnpaidEvidence(evidence)
        );
    }

    function issue(IssueEvidence calldata evidence, bytes[] calldata signatures)
        external
        nonReentrant
        returns (bytes32 id)
    {
        _validateIssueInput(evidence);
        (uint8 payoutBasis, uint8 clockMode, uint32 slaSeconds) = _validatePolicyLimits(evidence);
        uint64 deadline = clockMode == 0 ? evidence.verifiedAcceptanceAt + slaSeconds : 0;
        if (clockMode == 0 && deadline <= block.timestamp) revert InvalidCovenant();

        id = covenantId(evidence.policyId, evidence.jobId, evidence.buyer, evidence.feeAuthorization.authorizationHash);
        if (covenants[id].state != CovenantState.None) revert CovenantAlreadyExists();
        if (coveredJobCovenant[evidence.jobId] != bytes32(0)) revert JobAlreadyCovered();

        bytes32 digest =
            _consumeEvidence(evidenceVerifier, ISSUE_ACTION, hashIssueEvidence(evidence), signatures, false, id);
        coveredJobCovenant[evidence.jobId] = id;
        _storeCovenant(id, evidence, payoutBasis, clockMode, slaSeconds, deadline);
        bondVault.lock(id, evidence.provider, evidence.coverageCapAtomic);
        _emitCovenantIssued(id, evidence, digest);
    }

    function startClock(ClockEvidence calldata evidence, bytes[] calldata signatures) external nonReentrant {
        Covenant storage covenant = covenants[evidence.covenantId];
        if (covenant.state != CovenantState.PendingStart) revert CovenantNotActive();
        if (
            evidence.startedAt < covenant.issuedAt || evidence.startedAt > block.timestamp
                || evidence.startedAt > covenant.enrollmentExpiresAt
                || block.timestamp > uint256(covenant.feeAuthorizationValidBefore) + CLOCK_START_RECOVERY_PERIOD
                || evidence.evidenceHash == bytes32(0)
        ) revert InvalidCovenant();
        bytes32 digest = _consumeEvidence(
            evidenceVerifier, START_CLOCK_ACTION, hashClockEvidence(evidence), signatures, false, evidence.covenantId
        );
        covenant.startAt = evidence.startedAt;
        covenant.deadline = evidence.startedAt + covenant.slaSeconds;
        covenant.state = CovenantState.Active;
        emit CovenantClockStarted(
            evidence.covenantId, evidence.startedAt, covenant.deadline, evidence.evidenceHash, digest
        );
    }

    function expireUnstarted(bytes32 id) external nonReentrant {
        Covenant storage covenant = covenants[id];
        if (covenant.state != CovenantState.PendingStart) revert CovenantNotActive();
        if (block.timestamp <= uint256(covenant.feeAuthorizationValidBefore) + CLOCK_START_RECOVERY_PERIOD) {
            revert DeadlineNotElapsed();
        }
        covenant.state = CovenantState.Released;
        bondVault.release(id);
        emit CovenantReleased(id, 0, block.timestamp, keccak256("COVERAGE_CLOCK_NOT_STARTED"), bytes32(0));
    }

    function release(ReleaseEvidence calldata evidence, bytes[] calldata signatures) external nonReentrant {
        _release(evidence, signatures, evidenceVerifier, false);
    }

    /// @notice Resolves an active covenant through a separately operated recovery quorum.
    /// @dev The delay prevents the recovery quorum from competing with normal reconciliation.
    function emergencyRelease(ReleaseEvidence calldata evidence, bytes[] calldata signatures) external nonReentrant {
        Covenant storage covenant = covenants[evidence.covenantId];
        _requireEmergencyReleaseDelay(covenant);
        _release(evidence, signatures, recoveryEvidenceVerifier, true);
    }

    function markPayoutDue(BreachEvidence calldata evidence, bytes[] calldata signatures) external nonReentrant {
        _markPayoutDue(evidence, signatures, evidenceVerifier, false);
    }

    function emergencyMarkPayoutDue(BreachEvidence calldata evidence, bytes[] calldata signatures)
        external
        nonReentrant
    {
        Covenant storage covenant = covenants[evidence.covenantId];
        _requireEmergencyDelay(covenant, CovenantState.Active, covenant.deadline);
        _markPayoutDue(evidence, signatures, recoveryEvidenceVerifier, true);
    }

    function settleNetLoss(SettlementEvidence calldata evidence, bytes[] calldata signatures)
        external
        nonReentrant
        returns (uint256 payoutAtomic)
    {
        payoutAtomic = _settleNetLoss(evidence, signatures, evidenceVerifier, false);
    }

    function emergencySettleNetLoss(SettlementEvidence calldata evidence, bytes[] calldata signatures)
        external
        nonReentrant
        returns (uint256 payoutAtomic)
    {
        Covenant storage covenant = covenants[evidence.covenantId];
        _requireEmergencyDelay(covenant, CovenantState.PayoutDue, covenant.deadline);
        payoutAtomic = _settleNetLoss(evidence, signatures, recoveryEvidenceVerifier, true);
    }

    /// @notice Releases a bond only when the exact fee authorization bound at issuance expired unused.
    /// @dev The evidence quorum must independently verify that no fee settlement used the authorization.
    function cancelUnpaid(CancelUnpaidEvidence calldata evidence, bytes[] calldata signatures) external nonReentrant {
        _cancelUnpaid(evidence, signatures, evidenceVerifier, false);
    }

    /// @notice Delayed cancellation through the disjoint recovery quorum if the primary quorum is unavailable.
    function emergencyCancelUnpaid(CancelUnpaidEvidence calldata evidence, bytes[] calldata signatures)
        external
        nonReentrant
    {
        Covenant storage covenant = covenants[evidence.covenantId];
        if (
            covenant.feeAuthorizationValidBefore == 0
                || block.timestamp <= uint256(covenant.feeAuthorizationValidBefore) + EMERGENCY_EVIDENCE_DELAY
        ) revert EmergencyResolutionNotReady();
        _cancelUnpaid(evidence, signatures, recoveryEvidenceVerifier, true);
    }

    function _release(
        ReleaseEvidence calldata evidence,
        bytes[] calldata signatures,
        ICoverageEvidenceVerifier verifier,
        bool emergency
    ) private {
        Covenant storage covenant = covenants[evidence.covenantId];
        if (
            covenant.state != CovenantState.Active && covenant.state != CovenantState.PendingStart
                && covenant.state != CovenantState.PayoutDue
        ) {
            revert CovenantNotActive();
        }
        uint64 releaseDeadline =
            covenant.state == CovenantState.PendingStart ? covenant.enrollmentExpiresAt : covenant.deadline;
        if (
            evidence.completedAt < covenant.issuedAt || evidence.completedAt > releaseDeadline
                || evidence.observedAt < evidence.completedAt || evidence.observedAt > block.timestamp
                || evidence.evidenceHash == bytes32(0)
        ) revert InvalidCovenant();
        bytes32 digest = _consumeEvidence(
            verifier, RELEASE_ACTION, hashReleaseEvidence(evidence), signatures, emergency, evidence.covenantId
        );
        covenant.completedAt = evidence.completedAt;
        covenant.state = CovenantState.Released;
        bondVault.release(evidence.covenantId);
        emit CovenantReleased(
            evidence.covenantId, evidence.completedAt, evidence.observedAt, evidence.evidenceHash, digest
        );
    }

    function _markPayoutDue(
        BreachEvidence calldata evidence,
        bytes[] calldata signatures,
        ICoverageEvidenceVerifier verifier,
        bool emergency
    ) private {
        Covenant storage covenant = covenants[evidence.covenantId];
        if (covenant.state != CovenantState.Active) revert CovenantNotActive();
        if (block.timestamp <= covenant.deadline || evidence.observedAt <= covenant.deadline) {
            revert DeadlineNotElapsed();
        }
        if (evidence.observedAt > block.timestamp || evidence.evidenceHash == bytes32(0)) revert InvalidCovenant();
        bytes32 digest = _consumeEvidence(
            verifier, BREACH_ACTION, hashBreachEvidence(evidence), signatures, emergency, evidence.covenantId
        );
        covenant.state = CovenantState.PayoutDue;
        // The challenge must begin when the provisional breach is committed on chain.
        // A relayer may hold valid evidence, so its older observation timestamp cannot
        // be allowed to consume part or all of the provider's correction window.
        covenant.payoutDueAt = uint64(block.timestamp);
        covenant.breachEvidenceHash = evidence.evidenceHash;
        emit CovenantPayoutDue(evidence.covenantId, evidence.observedAt, evidence.evidenceHash, digest);
    }

    function _settleNetLoss(
        SettlementEvidence calldata evidence,
        bytes[] calldata signatures,
        ICoverageEvidenceVerifier verifier,
        bool emergency
    ) private returns (uint256 payoutAtomic) {
        Covenant storage covenant = covenants[evidence.covenantId];
        if (covenant.state != CovenantState.PayoutDue) revert CovenantNotActive();
        if (evidence.recoveryEvidenceHash == bytes32(0)) revert RecoveryEvidenceRequired();
        if (!evidence.recoveryFinalized) revert RecoveryNotFinal();
        if (evidence.observedAt < covenant.payoutDueAt || evidence.observedAt > block.timestamp) {
            revert InvalidCovenant();
        }
        if (block.timestamp > uint256(evidence.observedAt) + SETTLEMENT_EVIDENCE_MAX_AGE) revert EvidenceStale();
        if (block.timestamp <= uint256(covenant.payoutDueAt) + SETTLEMENT_CHALLENGE_PERIOD) {
            revert SettlementChallengeActive();
        }
        bytes32 digest = _consumeEvidence(
            verifier, SETTLEMENT_ACTION, hashSettlementEvidence(evidence), signatures, emergency, evidence.covenantId
        );
        covenant.recoveryEvidenceHash = evidence.recoveryEvidenceHash;
        covenant.recoveryObservedAt = evidence.observedAt;
        covenant.recoveryFinalized = true;

        uint256 recovered = uint256(evidence.escrowRefundAtomic) + uint256(evidence.otherRecoveryAtomic);
        if (covenant.payoutBasis == 1) {
            payoutAtomic = covenant.coverageCapAtomic;
        } else {
            uint256 netLoss =
                uint256(covenant.buyerPaidAtomic) > recovered ? uint256(covenant.buyerPaidAtomic) - recovered : 0;
            payoutAtomic = netLoss < covenant.coverageCapAtomic ? netLoss : covenant.coverageCapAtomic;
        }
        covenant.payoutAtomic = uint128(payoutAtomic);
        if (payoutAtomic == 0) {
            covenant.state = CovenantState.RecoveredWithoutPayout;
            bondVault.release(evidence.covenantId);
        } else {
            covenant.state = CovenantState.Paid;
            bondVault.slash(evidence.covenantId, covenant.buyer, payoutAtomic);
        }
        emit CovenantSettled(
            evidence.covenantId,
            payoutAtomic,
            evidence.escrowRefundAtomic,
            evidence.otherRecoveryAtomic,
            evidence.observedAt,
            evidence.recoveryFinalized,
            evidence.recoveryEvidenceHash,
            digest,
            covenant.state
        );
    }

    function _cancelUnpaid(
        CancelUnpaidEvidence calldata evidence,
        bytes[] calldata signatures,
        ICoverageEvidenceVerifier verifier,
        bool emergency
    ) private {
        Covenant storage covenant = covenants[evidence.covenantId];
        if (
            covenant.state != CovenantState.PendingStart && covenant.state != CovenantState.Active
                && covenant.state != CovenantState.PayoutDue
        ) revert CovenantNotActive();
        if (evidence.feeAuthorizationHash != covenant.feeAuthorizationHash) {
            revert PaymentAuthorizationMismatch();
        }
        if (
            evidence.observedAt <= covenant.feeAuthorizationValidBefore || evidence.observedAt > block.timestamp
                || evidence.nonSettlementEvidenceHash == bytes32(0)
        ) revert PaymentAuthorizationActive();
        if (block.timestamp > uint256(evidence.observedAt) + CANCELLATION_EVIDENCE_MAX_AGE) revert EvidenceStale();
        bytes32 digest = _consumeEvidence(
            verifier,
            CANCEL_UNPAID_ACTION,
            hashCancelUnpaidEvidence(evidence),
            signatures,
            emergency,
            evidence.covenantId
        );
        covenant.state = CovenantState.CancelledUnpaid;
        if (coveredJobCovenant[covenant.jobId] == evidence.covenantId) {
            coveredJobCovenant[covenant.jobId] = bytes32(0);
        }
        bondVault.release(evidence.covenantId);
        emit CovenantCancelledUnpaid(
            evidence.covenantId,
            evidence.observedAt,
            evidence.feeAuthorizationHash,
            evidence.nonSettlementEvidenceHash,
            digest
        );
    }

    function _requireEmergencyReleaseDelay(Covenant storage covenant) private view {
        if (covenant.state != CovenantState.Active && covenant.state != CovenantState.PayoutDue) {
            revert CovenantNotActive();
        }
        if (covenant.deadline == 0 || block.timestamp <= uint256(covenant.deadline) + EMERGENCY_EVIDENCE_DELAY) {
            revert EmergencyResolutionNotReady();
        }
    }

    function _requireEmergencyDelay(Covenant storage covenant, CovenantState requiredState, uint64 anchor)
        private
        view
    {
        if (covenant.state != requiredState) revert CovenantNotActive();
        if (anchor == 0 || block.timestamp <= uint256(anchor) + EMERGENCY_EVIDENCE_DELAY) {
            revert EmergencyResolutionNotReady();
        }
    }

    function _validateIssueInput(IssueEvidence calldata evidence) private view {
        if (evidence.provider == address(0) || evidence.buyer == address(0)) revert ZeroAddress();
        if (
            evidence.policyId == bytes32(0) || evidence.observedFingerprint == bytes32(0)
                || evidence.jobId == bytes32(0) || evidence.coverageCapAtomic == 0 || evidence.buyerPaidAtomic == 0
                || evidence.coverageCapAtomic > evidence.buyerPaidAtomic || evidence.verifiedAcceptanceAt == 0
                || evidence.verifiedAcceptanceAt > block.timestamp || evidence.enrollmentExpiresAt <= block.timestamp
                || evidence.acceptanceEvidenceHash == bytes32(0)
                || evidence.feeAuthorization.authorizationHash == bytes32(0)
                || evidence.feeAuthorization.validBefore <= block.timestamp
                || evidence.feeAuthorization.validBefore > block.timestamp + MAX_FEE_AUTHORIZATION_WINDOW
        ) revert InvalidCovenant();
    }

    function _validatePolicyLimits(IssueEvidence calldata evidence)
        private
        view
        returns (uint8 payoutBasis, uint8 clockMode, uint32 slaSeconds)
    {
        if (policyRegistry.policyProvider(evidence.policyId) != evidence.provider) revert ProviderMismatch();
        if (!policyRegistry.isCoverable(evidence.policyId, evidence.observedFingerprint)) revert PolicyNotCoverable();
        payoutBasis = policyRegistry.policyPayoutBasis(evidence.policyId);
        (clockMode, slaSeconds) = policyRegistry.policyClock(evidence.policyId);
        (uint128 policyMaxCapAtomic, uint32 enrollmentWindowSeconds) =
            policyRegistry.policyCoverageLimits(evidence.policyId);
        if (
            payoutBasis > 1 || clockMode > 1 || slaSeconds == 0 || evidence.coverageCapAtomic > policyMaxCapAtomic
                || enrollmentWindowSeconds == 0
                || uint256(evidence.enrollmentExpiresAt)
                    != uint256(evidence.verifiedAcceptanceAt) + enrollmentWindowSeconds
                || (clockMode == 1 && evidence.feeAuthorization.validBefore < evidence.enrollmentExpiresAt)
        ) revert InvalidCovenant();
    }

    function _storeCovenant(
        bytes32 id,
        IssueEvidence calldata evidence,
        uint8 payoutBasis,
        uint8 clockMode,
        uint32 slaSeconds,
        uint64 deadline
    ) private {
        covenants[id] = Covenant({
            id: id,
            policyId: evidence.policyId,
            jobId: evidence.jobId,
            provider: evidence.provider,
            buyer: evidence.buyer,
            coverageCapAtomic: evidence.coverageCapAtomic,
            buyerPaidAtomic: evidence.buyerPaidAtomic,
            issuedAt: uint64(block.timestamp),
            startAt: clockMode == 0 ? evidence.verifiedAcceptanceAt : 0,
            deadline: deadline,
            enrollmentExpiresAt: evidence.enrollmentExpiresAt,
            payoutDueAt: 0,
            completedAt: 0,
            recoveryObservedAt: 0,
            slaSeconds: slaSeconds,
            payoutBasis: payoutBasis,
            clockMode: clockMode,
            state: clockMode == 0 ? CovenantState.Active : CovenantState.PendingStart,
            payoutAtomic: 0,
            acceptanceEvidenceHash: evidence.acceptanceEvidenceHash,
            breachEvidenceHash: bytes32(0),
            recoveryEvidenceHash: bytes32(0),
            feeAuthorizationHash: evidence.feeAuthorization.authorizationHash,
            feeAuthorizationValidBefore: evidence.feeAuthorization.validBefore,
            recoveryFinalized: false
        });
    }

    function _emitCovenantIssued(bytes32 id, IssueEvidence calldata evidence, bytes32 digest) private {
        Covenant storage covenant = covenants[id];
        emit CovenantIssued(
            id,
            evidence.policyId,
            evidence.jobId,
            evidence.provider,
            evidence.buyer,
            evidence.coverageCapAtomic,
            evidence.buyerPaidAtomic,
            covenant.deadline,
            covenant.payoutBasis,
            covenant.clockMode,
            evidence.acceptanceEvidenceHash,
            evidence.feeAuthorization.authorizationHash,
            evidence.feeAuthorization.validBefore,
            digest
        );
    }

    function _consumeEvidence(
        ICoverageEvidenceVerifier verifier,
        bytes32 action,
        bytes32 payloadHash,
        bytes[] calldata signatures,
        bool emergency,
        bytes32 covenantId_
    ) private returns (bytes32 digest) {
        digest = verifier.verify(action, payloadHash, signatures);
        if (consumedEvidenceDigest[digest]) revert EvidenceAlreadyConsumed();
        consumedEvidenceDigest[digest] = true;
        if (emergency) emit EmergencyEvidenceUsed(covenantId_, action, address(verifier), digest);
    }

    function _validateEvidenceTopology() private view {
        uint256 primaryCount = evidenceVerifier.signerCount();
        uint256 recoveryCount = recoveryEvidenceVerifier.signerCount();
        if (
            primaryCount != REQUIRED_EVIDENCE_SIGNERS || recoveryCount != REQUIRED_EVIDENCE_SIGNERS
                || evidenceVerifier.threshold() != REQUIRED_EVIDENCE_THRESHOLD
                || recoveryEvidenceVerifier.threshold() != REQUIRED_EVIDENCE_THRESHOLD
        ) revert EvidenceTopologyInvalid();
        for (uint256 index; index < primaryCount; ++index) {
            address signer = evidenceVerifier.signerAt(index);
            if (signer == address(0)) revert EvidenceTopologyInvalid();
            if (recoveryEvidenceVerifier.isSigner(signer)) revert EvidenceSignerOverlap();
        }
    }
}
