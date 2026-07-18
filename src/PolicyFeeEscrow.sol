// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {CoverageManager} from "./CoverageManager.sol";

interface IPolicyFeeAsset {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;
}

interface IPolicyFeeEvidenceVerifier {
    function attestationDigest(address manager, bytes32 action, bytes32 payloadHash) external view returns (bytes32);

    function verify(bytes32 action, bytes32 payloadHash, bytes[] calldata signatures) external view returns (bytes32);
}

interface IPolicyFeeBondVault {
    function asset() external view returns (address);
}

/// @notice Refundable custody for a PolicyPool fee while a direct A2MCP request is executed.
/// @dev There is intentionally no owner or sweep path. A funded fee can move exactly once:
///      to the immutable treasury after quorum-attested provider settlement, or back to its
///      recorded buyer after the authorization window and a fixed grace period have elapsed.
contract PolicyFeeEscrow {
    error ZeroAddress();
    error ZeroAmount();
    error InvalidAuthorizationWindow();
    error InvalidCovenant();
    error FeeAlreadyExists();
    error FeeNotFunded();
    error FeeRefundWindowElapsed();
    error RefundNotReady();
    error InvalidCaptureEvidence();
    error EvidenceStale();
    error EvidenceAlreadyUsed();
    error TokenTransferFailed();
    error FeeOnTransferUnsupported();
    error Reentrancy();

    enum FeeState {
        None,
        Funded,
        Captured,
        Refunded
    }

    struct FeeRecord {
        address buyer;
        bytes32 covenantId;
        bytes32 providerAuthorizationHash;
        uint128 amountAtomic;
        uint64 fundedAt;
        uint64 authorizationValidBefore;
        uint64 refundAvailableAt;
        FeeState state;
    }

    struct CaptureEvidence {
        bytes32 feeId;
        bytes32 covenantId;
        bytes32 providerAuthorizationHash;
        bytes32 relayReceiptDigest;
        bytes32 providerSettlementTransaction;
        uint64 observedAt;
    }

    struct FundAuthorization {
        address buyer;
        bytes32 policyId;
        bytes32 jobId;
        bytes32 providerAuthorizationHash;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
        uint256 providerAuthorizationValidBefore;
    }

    uint256 public constant MAX_AUTHORIZATION_WINDOW = 15 minutes;
    uint256 public constant REFUND_GRACE_PERIOD = 2 minutes;
    uint256 public constant CAPTURE_EVIDENCE_MAX_AGE = 10 minutes;
    bytes32 public constant CAPTURE_ACTION = keccak256("CAPTURE_POLICYPOOL_FEE");
    bytes32 public constant AUTHORIZATION_NONCE_TYPEHASH = keccak256(
        "PolicyFeeAuthorization(bytes32 policyId,bytes32 jobId,address buyer,bytes32 providerAuthorizationHash,uint256 validAfter,uint256 validBefore,uint256 providerAuthorizationValidBefore)"
    );
    bytes32 public constant CAPTURE_TYPEHASH = keccak256(
        "CaptureEvidence(bytes32 feeId,bytes32 covenantId,bytes32 providerAuthorizationHash,bytes32 relayReceiptDigest,bytes32 providerSettlementTransaction,uint64 observedAt)"
    );

    IPolicyFeeAsset public immutable asset;
    IPolicyFeeEvidenceVerifier public immutable evidenceVerifier;
    CoverageManager public immutable coverageManager;
    address public immutable treasury;
    uint128 public immutable feeAmountAtomic;

    uint256 public totalEscrowedAtomic;
    mapping(bytes32 feeId => FeeRecord record) public fees;
    mapping(bytes32 evidenceDigest => bool consumed) public consumedEvidence;

    uint256 private entered = 1;

    event FeeFunded(
        bytes32 indexed feeId,
        bytes32 indexed covenantId,
        address indexed buyer,
        uint256 amountAtomic,
        uint256 refundAvailableAt
    );
    event FeeCaptured(
        bytes32 indexed feeId,
        bytes32 indexed covenantId,
        bytes32 indexed providerSettlementTransaction,
        uint256 amountAtomic
    );
    event FeeRefunded(bytes32 indexed feeId, bytes32 indexed covenantId, address indexed buyer, uint256 amountAtomic);

    modifier nonReentrant() {
        if (entered != 1) revert Reentrancy();
        entered = 2;
        _;
        entered = 1;
    }

    constructor(
        address asset_,
        address treasury_,
        address evidenceVerifier_,
        address coverageManager_,
        uint128 feeAmountAtomic_
    ) {
        if (
            asset_ == address(0) || treasury_ == address(0) || evidenceVerifier_ == address(0)
                || coverageManager_ == address(0)
        ) {
            revert ZeroAddress();
        }
        if (feeAmountAtomic_ == 0) revert ZeroAmount();
        CoverageManager manager = CoverageManager(coverageManager_);
        if (
            address(manager.evidenceVerifier()) != evidenceVerifier_
                || IPolicyFeeBondVault(address(manager.bondVault())).asset() != asset_
        ) revert InvalidCovenant();
        asset = IPolicyFeeAsset(asset_);
        treasury = treasury_;
        evidenceVerifier = IPolicyFeeEvidenceVerifier(evidenceVerifier_);
        coverageManager = manager;
        feeAmountAtomic = feeAmountAtomic_;
    }

    function authorizationNonce(
        bytes32 policyId,
        bytes32 jobId,
        address buyer,
        bytes32 providerAuthorizationHash,
        uint256 validAfter,
        uint256 validBefore,
        uint256 providerAuthorizationValidBefore
    ) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                AUTHORIZATION_NONCE_TYPEHASH,
                policyId,
                jobId,
                buyer,
                providerAuthorizationHash,
                validAfter,
                validBefore,
                providerAuthorizationValidBefore
            )
        );
    }

    function authorizationId(address buyer, uint256 validAfter, uint256 validBefore, bytes32 nonce)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                block.chainid, address(this), address(asset), buyer, feeAmountAtomic, validAfter, validBefore, nonce
            )
        );
    }

    function capturePayloadHash(CaptureEvidence calldata evidence) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                CAPTURE_TYPEHASH,
                evidence.feeId,
                evidence.covenantId,
                evidence.providerAuthorizationHash,
                evidence.relayReceiptDigest,
                evidence.providerSettlementTransaction,
                evidence.observedAt
            )
        );
    }

    function captureEvidenceDigest(CaptureEvidence calldata evidence) external view returns (bytes32) {
        return evidenceVerifier.attestationDigest(address(this), CAPTURE_ACTION, capturePayloadHash(evidence));
    }

    function getFee(bytes32 feeId) external view returns (FeeRecord memory) {
        return fees[feeId];
    }

    function fund(FundAuthorization calldata authorization, bytes calldata signature)
        external
        nonReentrant
        returns (bytes32 feeId)
    {
        _validateFundAuthorization(authorization);
        feeId = authorizationId(
            authorization.buyer, authorization.validAfter, authorization.validBefore, authorization.nonce
        );
        if (fees[feeId].state != FeeState.None) revert FeeAlreadyExists();
        bytes32 covenantId =
            coverageManager.covenantId(authorization.policyId, authorization.jobId, authorization.buyer, feeId);
        CoverageManager.Covenant memory covenant = coverageManager.getCovenant(covenantId);
        if (
            covenant.id != covenantId || covenant.policyId != authorization.policyId
                || covenant.jobId != authorization.jobId || covenant.buyer != authorization.buyer
                || covenant.feeAuthorizationHash != feeId
                || covenant.feeAuthorizationValidBefore != authorization.validBefore
                || covenant.state != CoverageManager.CovenantState.PendingStart
        ) revert InvalidCovenant();

        uint256 beforeBalance = asset.balanceOf(address(this));
        (bool success,) = address(asset)
            .call(
                abi.encodeWithSelector(
                    IPolicyFeeAsset.transferWithAuthorization.selector,
                    authorization.buyer,
                    address(this),
                    uint256(feeAmountAtomic),
                    authorization.validAfter,
                    authorization.validBefore,
                    authorization.nonce,
                    signature
                )
            );
        if (!success) revert TokenTransferFailed();
        uint256 afterBalance = asset.balanceOf(address(this));
        if (afterBalance < beforeBalance || afterBalance - beforeBalance != feeAmountAtomic) {
            revert FeeOnTransferUnsupported();
        }

        uint256 authorizationClose = authorization.validBefore > authorization.providerAuthorizationValidBefore
            ? authorization.validBefore
            : authorization.providerAuthorizationValidBefore;
        if (authorizationClose > type(uint64).max - REFUND_GRACE_PERIOD) revert InvalidAuthorizationWindow();
        uint64 refundAvailableAt = uint64(authorizationClose + REFUND_GRACE_PERIOD);
        fees[feeId] = FeeRecord({
            buyer: authorization.buyer,
            covenantId: covenantId,
            providerAuthorizationHash: authorization.providerAuthorizationHash,
            amountAtomic: feeAmountAtomic,
            fundedAt: uint64(block.timestamp),
            authorizationValidBefore: uint64(authorization.validBefore),
            refundAvailableAt: refundAvailableAt,
            state: FeeState.Funded
        });
        totalEscrowedAtomic += feeAmountAtomic;
        emit FeeFunded(feeId, covenantId, authorization.buyer, feeAmountAtomic, refundAvailableAt);
    }

    function capture(CaptureEvidence calldata evidence, bytes[] calldata signatures) external nonReentrant {
        FeeRecord storage current = fees[evidence.feeId];
        if (current.state != FeeState.Funded) revert FeeNotFunded();
        if (block.timestamp >= current.refundAvailableAt) revert FeeRefundWindowElapsed();
        if (
            evidence.covenantId != current.covenantId
                || evidence.providerAuthorizationHash != current.providerAuthorizationHash
                || evidence.relayReceiptDigest == bytes32(0) || evidence.providerSettlementTransaction == bytes32(0)
                || evidence.observedAt < current.fundedAt || evidence.observedAt > block.timestamp
        ) revert InvalidCaptureEvidence();
        if (block.timestamp - evidence.observedAt > CAPTURE_EVIDENCE_MAX_AGE) revert EvidenceStale();
        CoverageManager.Covenant memory covenant = coverageManager.getCovenant(current.covenantId);
        if (
            covenant.id != current.covenantId || covenant.buyer != current.buyer
                || covenant.feeAuthorizationHash != evidence.feeId
                || covenant.feeAuthorizationValidBefore != current.authorizationValidBefore
                || covenant.state == CoverageManager.CovenantState.None
                || covenant.state == CoverageManager.CovenantState.PendingStart
                || covenant.state == CoverageManager.CovenantState.CancelledUnpaid
        ) revert InvalidCovenant();

        bytes32 evidenceDigest = evidenceVerifier.verify(CAPTURE_ACTION, capturePayloadHash(evidence), signatures);
        if (consumedEvidence[evidenceDigest]) revert EvidenceAlreadyUsed();
        consumedEvidence[evidenceDigest] = true;

        current.state = FeeState.Captured;
        totalEscrowedAtomic -= current.amountAtomic;
        _safeTransfer(treasury, current.amountAtomic);
        emit FeeCaptured(
            evidence.feeId, current.covenantId, evidence.providerSettlementTransaction, current.amountAtomic
        );
    }

    function refund(bytes32 feeId) external nonReentrant {
        FeeRecord storage current = fees[feeId];
        if (current.state != FeeState.Funded) revert FeeNotFunded();
        if (block.timestamp < current.refundAvailableAt) revert RefundNotReady();

        current.state = FeeState.Refunded;
        totalEscrowedAtomic -= current.amountAtomic;
        _safeTransfer(current.buyer, current.amountAtomic);
        emit FeeRefunded(feeId, current.covenantId, current.buyer, current.amountAtomic);
    }

    function _validateFundAuthorization(FundAuthorization calldata authorization) private view {
        if (authorization.buyer == address(0)) revert ZeroAddress();
        if (
            authorization.policyId == bytes32(0) || authorization.jobId == bytes32(0)
                || authorization.providerAuthorizationHash == bytes32(0)
        ) revert InvalidCovenant();
        if (
            authorization.validAfter > block.timestamp || authorization.validBefore <= block.timestamp
                || authorization.validBefore > block.timestamp + MAX_AUTHORIZATION_WINDOW
                || authorization.providerAuthorizationValidBefore <= block.timestamp
                || authorization.providerAuthorizationValidBefore > block.timestamp + MAX_AUTHORIZATION_WINDOW
        ) revert InvalidAuthorizationWindow();
        if (
            authorization.nonce
                != authorizationNonce(
                    authorization.policyId,
                    authorization.jobId,
                    authorization.buyer,
                    authorization.providerAuthorizationHash,
                    authorization.validAfter,
                    authorization.validBefore,
                    authorization.providerAuthorizationValidBefore
                )
        ) revert InvalidCaptureEvidence();
    }

    function _safeTransfer(address to, uint256 amount) private {
        uint256 escrowBalanceBefore = asset.balanceOf(address(this));
        uint256 recipientBalanceBefore = asset.balanceOf(to);
        (bool success, bytes memory result) =
            address(asset).call(abi.encodeWithSelector(IPolicyFeeAsset.transfer.selector, to, amount));
        if (!success || (result.length != 0 && !abi.decode(result, (bool)))) revert TokenTransferFailed();
        uint256 escrowBalanceAfter = asset.balanceOf(address(this));
        uint256 recipientBalanceAfter = asset.balanceOf(to);
        if (
            escrowBalanceAfter > escrowBalanceBefore || escrowBalanceBefore - escrowBalanceAfter != amount
                || recipientBalanceAfter < recipientBalanceBefore
                || recipientBalanceAfter - recipientBalanceBefore != amount
        ) revert FeeOnTransferUnsupported();
    }
}
