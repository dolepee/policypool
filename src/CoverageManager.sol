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
    error EvidenceAlreadyConsumed();
    error Reentrancy();

    bytes32 public constant ISSUE_ACTION = keccak256("POLICYPOOL_ISSUE");
    bytes32 public constant START_CLOCK_ACTION = keccak256("POLICYPOOL_START_CLOCK");
    bytes32 public constant RELEASE_ACTION = keccak256("POLICYPOOL_RELEASE");
    bytes32 public constant BREACH_ACTION = keccak256("POLICYPOOL_BREACH");
    bytes32 public constant SETTLEMENT_ACTION = keccak256("POLICYPOOL_SETTLEMENT");

    bytes32 public constant ISSUE_EVIDENCE_TYPEHASH = keccak256(
        "IssueEvidence(bytes32 policyId,bytes32 observedFingerprint,bytes32 jobId,address provider,address buyer,uint128 coverageCapAtomic,uint128 buyerPaidAtomic,uint64 verifiedAcceptanceAt,uint64 enrollmentExpiresAt,bytes32 acceptanceEvidenceHash)"
    );
    bytes32 public constant CLOCK_EVIDENCE_TYPEHASH =
        keccak256("ClockEvidence(bytes32 covenantId,uint64 startedAt,bytes32 evidenceHash)");
    bytes32 public constant RELEASE_EVIDENCE_TYPEHASH =
        keccak256("ReleaseEvidence(bytes32 covenantId,uint64 observedAt,bytes32 evidenceHash)");
    bytes32 public constant BREACH_EVIDENCE_TYPEHASH =
        keccak256("BreachEvidence(bytes32 covenantId,uint64 observedAt,bytes32 evidenceHash)");
    bytes32 public constant SETTLEMENT_EVIDENCE_TYPEHASH = keccak256(
        "SettlementEvidence(bytes32 covenantId,uint128 escrowRefundAtomic,uint128 otherRecoveryAtomic,uint64 observedAt,bytes32 recoveryEvidenceHash)"
    );

    enum CovenantState {
        None,
        PendingStart,
        Active,
        Released,
        PayoutDue,
        Paid,
        RecoveredWithoutPayout
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
    }

    struct ClockEvidence {
        bytes32 covenantId;
        uint64 startedAt;
        bytes32 evidenceHash;
    }

    struct ReleaseEvidence {
        bytes32 covenantId;
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
        bytes32 recoveryEvidenceHash;
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
        uint32 slaSeconds;
        uint8 payoutBasis;
        uint8 clockMode;
        CovenantState state;
        uint128 payoutAtomic;
        bytes32 acceptanceEvidenceHash;
        bytes32 breachEvidenceHash;
        bytes32 recoveryEvidenceHash;
    }

    IPolicyRegistryView public immutable policyRegistry;
    IProviderBondManager public immutable bondVault;
    ICoverageEvidenceVerifier public immutable evidenceVerifier;

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
        bytes32 evidenceDigest
    );
    event CovenantClockStarted(
        bytes32 indexed covenantId, uint256 startedAt, uint256 deadline, bytes32 evidenceHash, bytes32 evidenceDigest
    );
    event CovenantReleased(
        bytes32 indexed covenantId, uint256 observedAt, bytes32 evidenceHash, bytes32 evidenceDigest
    );
    event CovenantPayoutDue(
        bytes32 indexed covenantId, uint256 observedAt, bytes32 breachEvidenceHash, bytes32 evidenceDigest
    );
    event CovenantSettled(
        bytes32 indexed covenantId,
        uint256 payoutAtomic,
        uint256 escrowRefundAtomic,
        uint256 otherRecoveryAtomic,
        bytes32 recoveryEvidenceHash,
        bytes32 evidenceDigest,
        CovenantState finalState
    );

    modifier nonReentrant() {
        if (entered != 1) revert Reentrancy();
        entered = 2;
        _;
        entered = 1;
    }

    constructor(address policyRegistry_, address bondVault_, address evidenceVerifier_) {
        if (policyRegistry_ == address(0) || bondVault_ == address(0) || evidenceVerifier_ == address(0)) {
            revert ZeroAddress();
        }
        policyRegistry = IPolicyRegistryView(policyRegistry_);
        bondVault = IProviderBondManager(bondVault_);
        evidenceVerifier = ICoverageEvidenceVerifier(evidenceVerifier_);
    }

    function getCovenant(bytes32 covenantId_) external view returns (Covenant memory) {
        return covenants[covenantId_];
    }

    function covenantId(bytes32 policyId, bytes32 jobId, address buyer) public pure returns (bytes32) {
        return keccak256(abi.encode(policyId, jobId, buyer));
    }

    function hashIssueEvidence(IssueEvidence memory evidence) public pure returns (bytes32) {
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
                evidence.acceptanceEvidenceHash
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
            abi.encode(RELEASE_EVIDENCE_TYPEHASH, evidence.covenantId, evidence.observedAt, evidence.evidenceHash)
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
                evidence.recoveryEvidenceHash
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

    function issue(IssueEvidence calldata evidence, bytes[] calldata signatures)
        external
        nonReentrant
        returns (bytes32 id)
    {
        _validateIssueInput(evidence);
        (uint8 payoutBasis, uint8 clockMode, uint32 slaSeconds) = _validatePolicyLimits(evidence);
        uint64 deadline = clockMode == 0 ? evidence.verifiedAcceptanceAt + slaSeconds : 0;
        if (clockMode == 0 && deadline <= block.timestamp) revert InvalidCovenant();

        id = covenantId(evidence.policyId, evidence.jobId, evidence.buyer);
        if (covenants[id].state != CovenantState.None) revert CovenantAlreadyExists();
        if (coveredJobCovenant[evidence.jobId] != bytes32(0)) revert JobAlreadyCovered();

        bytes32 digest = _consumeEvidence(ISSUE_ACTION, hashIssueEvidence(evidence), signatures);
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
                || block.timestamp > covenant.enrollmentExpiresAt || evidence.evidenceHash == bytes32(0)
        ) revert InvalidCovenant();
        bytes32 digest = _consumeEvidence(START_CLOCK_ACTION, hashClockEvidence(evidence), signatures);
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
        if (block.timestamp <= covenant.enrollmentExpiresAt) revert DeadlineNotElapsed();
        covenant.state = CovenantState.Released;
        bondVault.release(id);
        emit CovenantReleased(id, block.timestamp, keccak256("COVERAGE_CLOCK_NOT_STARTED"), bytes32(0));
    }

    function release(ReleaseEvidence calldata evidence, bytes[] calldata signatures) external nonReentrant {
        Covenant storage covenant = covenants[evidence.covenantId];
        if (covenant.state != CovenantState.Active && covenant.state != CovenantState.PendingStart) {
            revert CovenantNotActive();
        }
        if (
            evidence.observedAt < covenant.issuedAt || evidence.observedAt > block.timestamp
                || evidence.evidenceHash == bytes32(0)
        ) revert InvalidCovenant();
        bytes32 digest = _consumeEvidence(RELEASE_ACTION, hashReleaseEvidence(evidence), signatures);
        covenant.state = CovenantState.Released;
        bondVault.release(evidence.covenantId);
        emit CovenantReleased(evidence.covenantId, evidence.observedAt, evidence.evidenceHash, digest);
    }

    function markPayoutDue(BreachEvidence calldata evidence, bytes[] calldata signatures) external nonReentrant {
        Covenant storage covenant = covenants[evidence.covenantId];
        if (covenant.state != CovenantState.Active) revert CovenantNotActive();
        if (block.timestamp <= covenant.deadline || evidence.observedAt <= covenant.deadline) {
            revert DeadlineNotElapsed();
        }
        if (evidence.observedAt > block.timestamp || evidence.evidenceHash == bytes32(0)) revert InvalidCovenant();
        bytes32 digest = _consumeEvidence(BREACH_ACTION, hashBreachEvidence(evidence), signatures);
        covenant.state = CovenantState.PayoutDue;
        covenant.payoutDueAt = evidence.observedAt;
        covenant.breachEvidenceHash = evidence.evidenceHash;
        emit CovenantPayoutDue(evidence.covenantId, evidence.observedAt, evidence.evidenceHash, digest);
    }

    function settleNetLoss(SettlementEvidence calldata evidence, bytes[] calldata signatures)
        external
        nonReentrant
        returns (uint256 payoutAtomic)
    {
        Covenant storage covenant = covenants[evidence.covenantId];
        if (covenant.state != CovenantState.PayoutDue) revert CovenantNotActive();
        if (evidence.recoveryEvidenceHash == bytes32(0)) revert RecoveryEvidenceRequired();
        if (evidence.observedAt < covenant.payoutDueAt || evidence.observedAt > block.timestamp) {
            revert InvalidCovenant();
        }
        bytes32 digest = _consumeEvidence(SETTLEMENT_ACTION, hashSettlementEvidence(evidence), signatures);
        covenant.recoveryEvidenceHash = evidence.recoveryEvidenceHash;

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
            evidence.recoveryEvidenceHash,
            digest,
            covenant.state
        );
    }

    function _validateIssueInput(IssueEvidence calldata evidence) private view {
        if (evidence.provider == address(0) || evidence.buyer == address(0)) revert ZeroAddress();
        if (
            evidence.policyId == bytes32(0) || evidence.observedFingerprint == bytes32(0)
                || evidence.jobId == bytes32(0) || evidence.coverageCapAtomic == 0 || evidence.buyerPaidAtomic == 0
                || evidence.coverageCapAtomic > evidence.buyerPaidAtomic || evidence.verifiedAcceptanceAt == 0
                || evidence.verifiedAcceptanceAt > block.timestamp || evidence.enrollmentExpiresAt <= block.timestamp
                || evidence.acceptanceEvidenceHash == bytes32(0)
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
            slaSeconds: slaSeconds,
            payoutBasis: payoutBasis,
            clockMode: clockMode,
            state: clockMode == 0 ? CovenantState.Active : CovenantState.PendingStart,
            payoutAtomic: 0,
            acceptanceEvidenceHash: evidence.acceptanceEvidenceHash,
            breachEvidenceHash: bytes32(0),
            recoveryEvidenceHash: bytes32(0)
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
            digest
        );
    }

    function _consumeEvidence(bytes32 action, bytes32 payloadHash, bytes[] calldata signatures)
        private
        returns (bytes32 digest)
    {
        digest = evidenceVerifier.verify(action, payloadHash, signatures);
        if (consumedEvidenceDigest[digest]) revert EvidenceAlreadyConsumed();
        consumedEvidenceDigest[digest] = true;
    }
}
