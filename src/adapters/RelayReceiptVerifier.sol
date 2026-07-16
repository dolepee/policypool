// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Verifies PolicyPool relay receipts signed over a bytes32 digest.
contract RelayReceiptVerifier {
    error Unauthorized();
    error ZeroAddress();
    error InvalidSignature();

    uint256 private constant SECP256K1N_HALF = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    address public owner;
    address public pendingOwner;
    address public trustedSigner;

    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event TrustedSignerUpdated(address indexed previousSigner, address indexed newSigner);

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(address owner_, address trustedSigner_) {
        if (owner_ == address(0) || trustedSigner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        trustedSigner = trustedSigner_;
        emit OwnershipTransferred(address(0), owner_);
        emit TrustedSignerUpdated(address(0), trustedSigner_);
    }

    function verify(bytes32 receiptDigest, bytes calldata signature) external view returns (bool) {
        return _recover(_messageDigest(receiptDigest), signature) == trustedSigner;
    }

    function messageDigest(bytes32 receiptDigest) external pure returns (bytes32) {
        return _messageDigest(receiptDigest);
    }

    function setTrustedSigner(address nextSigner) external onlyOwner {
        if (nextSigner == address(0)) revert ZeroAddress();
        address previous = trustedSigner;
        trustedSigner = nextSigner;
        emit TrustedSignerUpdated(previous, nextSigner);
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

    function _messageDigest(bytes32 receiptDigest) private pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", receiptDigest));
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
