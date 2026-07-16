// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {CoverageEvidenceVerifier} from "../src/CoverageEvidenceVerifier.sol";
import {CoverageEvidenceTestBase} from "./helpers/CoverageEvidenceTestBase.sol";

contract CoverageEvidenceVerifierTest is CoverageEvidenceTestBase {
    address internal manager = makeAddr("manager");
    bytes32 internal constant ACTION = keccak256("ISSUE");
    bytes32 internal constant PAYLOAD = keccak256("payload");

    function setUp() public {
        _setUpEvidenceVerifier();
    }

    function testThresholdEvidenceIsBoundToManagerActionPayloadChainAndVerifier() public {
        assertEq(evidenceVerifier.signerCount(), 5);
        assertEq(evidenceVerifier.threshold(), 3);
        assertEq(evidenceVerifier.signerAt(0), evidenceSignerOne);
        assertNotEq(evidenceVerifier.domainSeparator(), bytes32(0));
        bytes32 digest = evidenceVerifier.attestationDigest(manager, ACTION, PAYLOAD);
        bytes[] memory signatures = _signatures(digest);
        vm.prank(manager);
        assertEq(evidenceVerifier.verify(ACTION, PAYLOAD, signatures), digest);

        vm.prank(makeAddr("other-manager"));
        vm.expectRevert(CoverageEvidenceVerifier.InvalidSignature.selector);
        evidenceVerifier.verify(ACTION, PAYLOAD, signatures);

        vm.prank(manager);
        vm.expectRevert(CoverageEvidenceVerifier.InvalidSignature.selector);
        evidenceVerifier.verify(keccak256("OTHER_ACTION"), PAYLOAD, signatures);

        vm.chainId(block.chainid + 1);
        vm.prank(manager);
        vm.expectRevert(CoverageEvidenceVerifier.InvalidSignature.selector);
        evidenceVerifier.verify(ACTION, PAYLOAD, signatures);
    }

    function testRejectsInvalidAttestationDomainInputs() public {
        vm.expectRevert(CoverageEvidenceVerifier.ZeroAddress.selector);
        evidenceVerifier.attestationDigest(address(0), ACTION, PAYLOAD);
        vm.expectRevert(CoverageEvidenceVerifier.InvalidAttestation.selector);
        evidenceVerifier.attestationDigest(manager, bytes32(0), PAYLOAD);
        vm.expectRevert(CoverageEvidenceVerifier.InvalidAttestation.selector);
        evidenceVerifier.attestationDigest(manager, ACTION, bytes32(0));
    }

    function testRejectsInsufficientUnorderedDuplicateUnauthorizedAndMalformedSignatures() public {
        bytes32 digest = evidenceVerifier.attestationDigest(manager, ACTION, PAYLOAD);
        bytes[] memory valid = _signatures(digest);

        bytes[] memory one = new bytes[](1);
        one[0] = valid[0];
        vm.prank(manager);
        vm.expectRevert(CoverageEvidenceVerifier.InsufficientSignatures.selector);
        evidenceVerifier.verify(ACTION, PAYLOAD, one);

        bytes[] memory reversed = new bytes[](3);
        reversed[0] = valid[2];
        reversed[1] = valid[1];
        reversed[2] = valid[0];
        vm.prank(manager);
        vm.expectRevert(CoverageEvidenceVerifier.SignaturesNotOrdered.selector);
        evidenceVerifier.verify(ACTION, PAYLOAD, reversed);

        bytes[] memory duplicate = new bytes[](3);
        duplicate[0] = valid[0];
        duplicate[1] = valid[0];
        duplicate[2] = valid[2];
        vm.prank(manager);
        vm.expectRevert(CoverageEvidenceVerifier.SignaturesNotOrdered.selector);
        evidenceVerifier.verify(ACTION, PAYLOAD, duplicate);

        (, uint256 unauthorizedKey) = makeAddrAndKey("unauthorized-signer");
        bytes[] memory unauthorized = new bytes[](3);
        unauthorized[0] = valid[0];
        unauthorized[1] = _signature(unauthorizedKey, digest);
        unauthorized[2] = valid[2];
        vm.prank(manager);
        vm.expectRevert();
        evidenceVerifier.verify(ACTION, PAYLOAD, unauthorized);

        bytes[] memory malformed = new bytes[](3);
        malformed[0] = hex"00";
        malformed[1] = valid[1];
        malformed[2] = valid[2];
        vm.prank(manager);
        vm.expectRevert(CoverageEvidenceVerifier.InvalidSignature.selector);
        evidenceVerifier.verify(ACTION, PAYLOAD, malformed);

        bytes[] memory tooMany = new bytes[](6);
        vm.prank(manager);
        vm.expectRevert(CoverageEvidenceVerifier.InvalidSignature.selector);
        evidenceVerifier.verify(ACTION, PAYLOAD, tooMany);

        bytes[] memory highS = new bytes[](3);
        highS[0] = abi.encodePacked(bytes32(0), bytes32(type(uint256).max), uint8(27));
        highS[1] = valid[1];
        highS[2] = valid[2];
        vm.prank(manager);
        vm.expectRevert(CoverageEvidenceVerifier.InvalidSignature.selector);
        evidenceVerifier.verify(ACTION, PAYLOAD, highS);

        bytes[] memory invalidV = new bytes[](3);
        invalidV[0] = valid[0];
        invalidV[0][64] = bytes1(uint8(29));
        invalidV[1] = valid[1];
        invalidV[2] = valid[2];
        vm.prank(manager);
        vm.expectRevert(CoverageEvidenceVerifier.InvalidSignature.selector);
        evidenceVerifier.verify(ACTION, PAYLOAD, invalidV);

        bytes[] memory zeroSigner = new bytes[](3);
        zeroSigner[0] = abi.encodePacked(bytes32(0), bytes32(0), uint8(27));
        zeroSigner[1] = valid[1];
        zeroSigner[2] = valid[2];
        vm.prank(manager);
        vm.expectRevert(CoverageEvidenceVerifier.InvalidSignature.selector);
        evidenceVerifier.verify(ACTION, PAYLOAD, zeroSigner);
    }

    function testConstructorRejectsWeakOrInvalidSignerSets() public {
        address[] memory oneSigner = new address[](1);
        oneSigner[0] = evidenceSignerOne;
        vm.expectRevert(CoverageEvidenceVerifier.InvalidThreshold.selector);
        new CoverageEvidenceVerifier(oneSigner, 1);
        vm.expectRevert(CoverageEvidenceVerifier.InvalidThreshold.selector);
        new CoverageEvidenceVerifier(oneSigner, 2);

        address[] memory tooFew = new address[](4);
        tooFew[0] = evidenceSignerOne;
        tooFew[1] = evidenceSignerTwo;
        tooFew[2] = evidenceSignerThree;
        tooFew[3] = evidenceSignerFour;
        vm.expectRevert(CoverageEvidenceVerifier.InvalidThreshold.selector);
        new CoverageEvidenceVerifier(tooFew, 3);

        address[] memory duplicate = new address[](5);
        duplicate[0] = evidenceSignerOne;
        duplicate[1] = evidenceSignerOne;
        duplicate[2] = evidenceSignerThree;
        duplicate[3] = evidenceSignerFour;
        duplicate[4] = evidenceSignerFive;
        vm.expectRevert(CoverageEvidenceVerifier.DuplicateSigner.selector);
        new CoverageEvidenceVerifier(duplicate, 3);

        address[] memory zero = new address[](5);
        zero[0] = evidenceSignerOne;
        zero[1] = evidenceSignerTwo;
        zero[2] = evidenceSignerThree;
        zero[3] = evidenceSignerFour;
        vm.expectRevert(CoverageEvidenceVerifier.ZeroAddress.selector);
        new CoverageEvidenceVerifier(zero, 3);

        address[] memory tooMany = new address[](17);
        for (uint256 index; index < tooMany.length; ++index) {
            tooMany[index] = address(uint160(index + 1));
        }
        vm.expectRevert(CoverageEvidenceVerifier.TooManySigners.selector);
        new CoverageEvidenceVerifier(tooMany, 3);
    }
}
