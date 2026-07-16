// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Immutable threshold verification for independently observed coverage evidence.
/// @dev Signatures are EIP-712 bound to this verifier, the destination manager, the
///      action, the payload, and the current chain. Signers cannot be changed after deployment.
contract CoverageEvidenceVerifier {
    error ZeroAddress();
    error InvalidThreshold();
    error TooManySigners();
    error DuplicateSigner();
    error InvalidSignature();
    error InvalidAttestation();
    error SignaturesNotOrdered();
    error InsufficientSignatures();

    uint256 public constant MAX_SIGNERS = 16;
    uint256 public constant MIN_SIGNERS = 5;
    uint256 public constant MIN_THRESHOLD = 3;
    uint256 private constant SECP256K1N_HALF = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("PolicyPool Coverage Evidence");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 public constant ATTESTATION_TYPEHASH =
        keccak256("CoverageAttestation(address manager,bytes32 action,bytes32 payloadHash)");

    uint8 public immutable threshold;
    address[] private signers;
    mapping(address signer => bool authorized) public isSigner;

    event EvidenceVerifierConfigured(address[] signers, uint256 threshold);

    constructor(address[] memory signers_, uint8 threshold_) {
        uint256 count = signers_.length;
        if (count > MAX_SIGNERS) revert TooManySigners();
        if (count < MIN_SIGNERS || threshold_ < MIN_THRESHOLD || threshold_ > count) revert InvalidThreshold();
        for (uint256 index; index < count; ++index) {
            address signer = signers_[index];
            if (signer == address(0)) revert ZeroAddress();
            if (isSigner[signer]) revert DuplicateSigner();
            isSigner[signer] = true;
            signers.push(signer);
        }
        threshold = threshold_;
        emit EvidenceVerifierConfigured(signers_, threshold_);
    }

    function signerCount() external view returns (uint256) {
        return signers.length;
    }

    function signerAt(uint256 index) external view returns (address) {
        return signers[index];
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function attestationDigest(address manager, bytes32 action, bytes32 payloadHash) public view returns (bytes32) {
        if (manager == address(0)) revert ZeroAddress();
        if (action == bytes32(0) || payloadHash == bytes32(0)) revert InvalidAttestation();
        bytes32 structHash = keccak256(abi.encode(ATTESTATION_TYPEHASH, manager, action, payloadHash));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// @notice Verifies evidence for the calling manager and returns its replay-protection digest.
    function verify(bytes32 action, bytes32 payloadHash, bytes[] calldata signatures)
        external
        view
        returns (bytes32 digest)
    {
        if (signatures.length < threshold) revert InsufficientSignatures();
        if (signatures.length > signers.length) revert InvalidSignature();
        digest = attestationDigest(msg.sender, action, payloadHash);
        address previous = address(0);
        for (uint256 index; index < signatures.length; ++index) {
            address recovered = _recover(digest, signatures[index]);
            if (recovered <= previous) revert SignaturesNotOrdered();
            if (!isSigner[recovered]) revert InvalidSignature();
            previous = recovered;
        }
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
