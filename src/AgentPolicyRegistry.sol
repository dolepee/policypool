// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IERC8004Owner {
    function ownerOf(uint256 agentId) external view returns (address);
}

interface IProviderBondView {
    function availableBond(address provider) external view returns (uint256);
}

/// @notice Versioned, opt-in policies for bonded agent-service providers.
/// @dev Existing covenants pin a policy id; new versions never mutate prior terms.
contract AgentPolicyRegistry {
    error Unauthorized();
    error ZeroAddress();
    error InvalidPolicy();
    error AgentOwnerMismatch();
    error InsufficientProviderBond();
    error PolicyNotActive();
    error FingerprintUnchanged();
    error SignatureExpired();
    error InvalidNonce();
    error InvalidSignature();

    bytes32 public constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant NAME_HASH = keccak256("PolicyPool Provider Enrollment");
    bytes32 public constant VERSION_HASH = keccak256("0.4.0");
    bytes32 public constant ENROLLMENT_TYPEHASH =
        keccak256("PolicyEnrollment(address provider,bytes32 policyTermsHash,uint256 nonce,uint256 deadline)");
    bytes32 public constant POLICY_IDENTITY_TYPEHASH = keccak256(
        "PolicyIdentity(bytes32 marketplace,uint256 agentId,uint256 serviceId,bytes32 serviceFingerprint,bytes32 scopeHash)"
    );
    bytes32 public constant POLICY_ECONOMICS_TYPEHASH = keccak256(
        "PolicyEconomics(uint32 slaSeconds,uint32 enrollmentWindowSeconds,uint128 maxCapAtomic,uint16 premiumBps,uint8 payoutBasis,uint8 clockMode,uint64 expiresAt,address adapter)"
    );
    bytes32 public constant POLICY_TERMS_TYPEHASH =
        keccak256("PolicyTerms(bytes32 identityHash,bytes32 economicsHash)");
    uint256 private constant SECP256K1N_HALF = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    struct PolicyTerms {
        bytes32 marketplace;
        uint256 agentId;
        uint256 serviceId;
        bytes32 serviceFingerprint;
        bytes32 scopeHash;
        uint32 slaSeconds;
        uint32 enrollmentWindowSeconds;
        uint128 maxCapAtomic;
        uint16 premiumBps;
        uint8 payoutBasis;
        uint8 clockMode;
        uint64 expiresAt;
        address adapter;
    }

    struct Policy {
        bytes32 id;
        bytes32 serviceKey;
        address provider;
        PolicyTerms terms;
        uint32 version;
        uint64 registeredAt;
        bool active;
        bytes32 suspensionReason;
    }

    IERC8004Owner public immutable identityRegistry;
    IProviderBondView public immutable bondVault;
    uint256 public immutable minimumBondAtomic;
    uint32 public immutable maximumSlaSeconds;

    address public owner;
    address public pendingOwner;
    address public monitor;

    mapping(bytes32 policyId => Policy policy) private policies;
    mapping(bytes32 serviceKey => bytes32 policyId) public latestPolicyId;
    mapping(bytes32 serviceKey => uint32 version) public latestVersion;
    mapping(address provider => uint256 nonce) public nonces;

    event MonitorUpdated(address indexed previousMonitor, address indexed newMonitor);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event PolicyRegistered(
        bytes32 indexed policyId,
        bytes32 indexed serviceKey,
        address indexed provider,
        uint256 agentId,
        uint256 serviceId,
        uint32 version,
        bytes32 serviceFingerprint
    );
    event PolicyPaused(bytes32 indexed policyId, address indexed provider, bytes32 reason);
    event PolicySuspended(bytes32 indexed policyId, bytes32 expectedFingerprint, bytes32 observedFingerprint);

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(
        address identityRegistry_,
        address bondVault_,
        address owner_,
        uint256 minimumBondAtomic_,
        uint32 maximumSlaSecondsValue
    ) {
        if (identityRegistry_ == address(0) || bondVault_ == address(0) || owner_ == address(0)) {
            revert ZeroAddress();
        }
        if (minimumBondAtomic_ == 0 || maximumSlaSecondsValue == 0) revert InvalidPolicy();
        identityRegistry = IERC8004Owner(identityRegistry_);
        bondVault = IProviderBondView(bondVault_);
        owner = owner_;
        monitor = owner_;
        emit OwnershipTransferred(address(0), owner_);
        minimumBondAtomic = minimumBondAtomic_;
        maximumSlaSeconds = maximumSlaSecondsValue;
    }

    function getPolicy(bytes32 policyId) external view returns (Policy memory) {
        return policies[policyId];
    }

    function policyProvider(bytes32 policyId) external view returns (address) {
        return policies[policyId].provider;
    }

    function policyPayoutBasis(bytes32 policyId) external view returns (uint8) {
        return policies[policyId].terms.payoutBasis;
    }

    function policyClock(bytes32 policyId) external view returns (uint8 clockMode, uint32 slaSeconds) {
        Policy storage policy = policies[policyId];
        return (policy.terms.clockMode, policy.terms.slaSeconds);
    }

    function policyCoverageLimits(bytes32 policyId)
        external
        view
        returns (uint128 maxCapAtomic, uint32 enrollmentWindowSeconds)
    {
        Policy storage policy = policies[policyId];
        return (policy.terms.maxCapAtomic, policy.terms.enrollmentWindowSeconds);
    }

    function serviceKey(bytes32 marketplace, uint256 agentId, uint256 serviceId) public pure returns (bytes32) {
        return keccak256(abi.encode(marketplace, agentId, serviceId));
    }

    function registerPolicy(PolicyTerms calldata terms) external returns (bytes32 policyId) {
        return _registerPolicy(msg.sender, terms);
    }

    function registerPolicyBySig(
        address provider,
        PolicyTerms calldata terms,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external returns (bytes32 policyId) {
        if (block.timestamp > deadline) revert SignatureExpired();
        if (nonce != nonces[provider]) revert InvalidNonce();
        bytes32 digest = enrollmentDigest(provider, terms, nonce, deadline);
        if (_recover(digest, signature) != provider) revert InvalidSignature();
        nonces[provider] = nonce + 1;
        return _registerPolicy(provider, terms);
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function enrollmentDigest(address provider, PolicyTerms calldata terms, uint256 nonce, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash =
            keccak256(abi.encode(ENROLLMENT_TYPEHASH, provider, policyTermsHash(terms), nonce, deadline));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function policyTermsHash(PolicyTerms calldata terms) public pure returns (bytes32) {
        bytes32 identityHash = keccak256(
            abi.encode(
                POLICY_IDENTITY_TYPEHASH,
                terms.marketplace,
                terms.agentId,
                terms.serviceId,
                terms.serviceFingerprint,
                terms.scopeHash
            )
        );
        bytes32 economicsHash = keccak256(
            abi.encode(
                POLICY_ECONOMICS_TYPEHASH,
                terms.slaSeconds,
                terms.enrollmentWindowSeconds,
                terms.maxCapAtomic,
                terms.premiumBps,
                terms.payoutBasis,
                terms.clockMode,
                terms.expiresAt,
                terms.adapter
            )
        );
        return keccak256(abi.encode(POLICY_TERMS_TYPEHASH, identityHash, economicsHash));
    }

    function _registerPolicy(address provider, PolicyTerms calldata terms) private returns (bytes32 policyId) {
        _validateTerms(terms);
        if (identityRegistry.ownerOf(terms.agentId) != provider) revert AgentOwnerMismatch();
        if (bondVault.availableBond(provider) < minimumBondAtomic) revert InsufficientProviderBond();
        if (uint256(terms.maxCapAtomic) > bondVault.availableBond(provider)) revert InsufficientProviderBond();

        bytes32 key = serviceKey(terms.marketplace, terms.agentId, terms.serviceId);
        uint32 version = latestVersion[key] + 1;
        policyId = keccak256(abi.encode(key, version, provider, terms.serviceFingerprint, terms.scopeHash));
        Policy storage policy = policies[policyId];
        policy.id = policyId;
        policy.serviceKey = key;
        policy.provider = provider;
        policy.terms = terms;
        policy.version = version;
        policy.registeredAt = uint64(block.timestamp);
        policy.active = true;

        latestVersion[key] = version;
        latestPolicyId[key] = policyId;
        emit PolicyRegistered(
            policyId, key, provider, terms.agentId, terms.serviceId, version, terms.serviceFingerprint
        );
    }

    function pausePolicy(bytes32 policyId, bytes32 reason) external {
        Policy storage policy = policies[policyId];
        if (!policy.active) revert PolicyNotActive();
        if (msg.sender != policy.provider && msg.sender != owner) revert Unauthorized();
        policy.active = false;
        policy.suspensionReason = reason;
        emit PolicyPaused(policyId, policy.provider, reason);
    }

    function suspendForFingerprint(bytes32 policyId, bytes32 observedFingerprint) external {
        if (msg.sender != monitor) revert Unauthorized();
        Policy storage policy = policies[policyId];
        if (!policy.active) revert PolicyNotActive();
        if (observedFingerprint == policy.terms.serviceFingerprint) revert FingerprintUnchanged();
        policy.active = false;
        policy.suspensionReason = keccak256("SERVICE_FINGERPRINT_CHANGED");
        emit PolicySuspended(policyId, policy.terms.serviceFingerprint, observedFingerprint);
    }

    function isCoverable(bytes32 policyId, bytes32 observedFingerprint) external view returns (bool) {
        Policy storage policy = policies[policyId];
        return policy.active && policy.id != bytes32(0) && latestPolicyId[policy.serviceKey] == policyId
            && policy.terms.expiresAt > block.timestamp && policy.terms.serviceFingerprint == observedFingerprint
            && identityRegistry.ownerOf(policy.terms.agentId) == policy.provider
            && bondVault.availableBond(policy.provider) >= minimumBondAtomic;
    }

    function setMonitor(address nextMonitor) external onlyOwner {
        if (nextMonitor == address(0)) revert ZeroAddress();
        address previous = monitor;
        monitor = nextMonitor;
        emit MonitorUpdated(previous, nextMonitor);
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

    function _validateTerms(PolicyTerms calldata terms) private view {
        if (
            terms.marketplace == bytes32(0) || terms.agentId == 0 || terms.serviceId == 0
                || terms.serviceFingerprint == bytes32(0) || terms.scopeHash == bytes32(0)
                || terms.adapter == address(0) || terms.maxCapAtomic == 0 || terms.expiresAt <= block.timestamp
        ) revert InvalidPolicy();
        if (
            terms.slaSeconds == 0 || terms.slaSeconds > maximumSlaSeconds || terms.enrollmentWindowSeconds == 0
                || terms.enrollmentWindowSeconds > terms.slaSeconds
                || terms.expiresAt <= block.timestamp + terms.slaSeconds
        ) revert InvalidPolicy();
        if (terms.premiumBps > 10_000 || terms.payoutBasis > 1 || terms.clockMode > 1) revert InvalidPolicy();
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address signer) {
        if (signature.length != 65) revert InvalidSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > SECP256K1N_HALF || (v != 27 && v != 28)) revert InvalidSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
    }
}
