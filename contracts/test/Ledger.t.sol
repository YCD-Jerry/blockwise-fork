// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Base} from "./Base.sol";
import {Ledger} from "../src/Ledger.sol";
import {Evaluator} from "../src/Evaluator.sol";

contract LedgerTest is Base {
    function test_onlyEvaluatorWrites() public {
        bytes32 k = keccak256("k");
        vm.expectRevert(Ledger.NotEvaluator.selector);
        ledger.recordDev(k, alice, 1, 1, 0, 0);
        vm.expectRevert(Ledger.NotEvaluator.selector);
        ledger.recordConfirm(k, 1, 1);
        vm.expectRevert(Ledger.NotEvaluator.selector);
        ledger.recordSealed(k, 1, 1);
        vm.prank(alice);
        vm.expectRevert(Ledger.NotEvaluator.selector);
        ledger.recordDev(k, alice, 1, 1, 0, 0);
    }

    function test_unboundLedgerRejectsEveryone() public {
        Ledger l = new Ledger();
        vm.expectRevert(Ledger.NotEvaluator.selector);
        l.recordDev(bytes32(uint256(1)), alice, 1, 1, 0, 0);
    }

    function test_bindOnce() public {
        vm.expectRevert(Ledger.AlreadyBound.selector);
        ledger.bind(address(0xdead));
    }

    function test_bindOnlyOwner() public {
        Ledger l = new Ledger();
        vm.prank(alice);
        vm.expectRevert(Ledger.NotOwner.selector);
        l.bind(alice);
    }

    function test_writeOnceDevConfirmSealed() public {
        int16[7] memory p = goodSpec();
        vm.startPrank(alice);
        ev.evaluate(1, 2, p, metaZero());
        vm.expectRevert(Ledger.AlreadyRecorded.selector);
        ev.evaluate(1, 2, p, metaZero());
        ev.confirm(1, 2, p);
        vm.expectRevert(Ledger.AlreadyRecorded.selector);
        ev.confirm(1, 2, p);
        ev.sealedLook(1, 2, p);
        vm.expectRevert(Ledger.AlreadyRecorded.selector);
        ev.sealedLook(1, 2, p);
        vm.stopPrank();
    }

    function test_writeOnceAtLedgerLevel() public {
        // the bound evaluator (here: this contract) still cannot overwrite
        Ledger l = new Ledger();
        l.bind(address(this));
        bytes32 k = bytes32(uint256(7));
        l.recordDev(k, alice, 5, 1, 0, 1);
        vm.expectRevert(Ledger.AlreadyRecorded.selector);
        l.recordDev(k, alice, 6, 1, 0, 1);
        l.recordConfirm(k, 1, 1);
        vm.expectRevert(Ledger.AlreadyRecorded.selector);
        l.recordConfirm(k, 2, 2);
        l.recordSealed(k, 1, 1);
        vm.expectRevert(Ledger.AlreadyRecorded.selector);
        l.recordSealed(k, 2, 2);
    }

    function test_confirmSealedNeedDevRecord() public {
        Ledger l = new Ledger();
        l.bind(address(this));
        vm.expectRevert(Ledger.NotRecorded.selector);
        l.recordConfirm(bytes32(uint256(9)), 1, 1);
        vm.expectRevert(Ledger.NotRecorded.selector);
        l.recordSealed(bytes32(uint256(9)), 1, 1);
    }

    function test_recordRoundTripNegativeScore() public {
        Ledger l = new Ledger();
        l.bind(address(this));
        bytes32 k = bytes32(uint256(3));
        l.recordDev(k, alice, -1234, 77, 2, 0xABCDEF1234);
        (address pr, int32 d, uint16 t, uint8 op, uint40 h, bool f) = l.getDev(k);
        assertEq(pr, alice);
        assertEq(d, -1234);
        assertEq(t, 77);
        assertEq(op, 2);
        assertEq(h, 0xABCDEF1234);
        assertTrue(f);
        l.recordConfirm(k, -9, 4);
        (int32 s, uint16 tr, bool cf) = l.getConfirm(k);
        assertEq(s, -9);
        assertEq(tr, 4);
        assertTrue(cf);
        (,, bool sf) = l.getSealed(k);
        assertFalse(sf);
        assertTrue(l.exists(k));
        assertFalse(l.exists(bytes32(uint256(4))));
        assertEq(l.keyOf(alice, 1, 2), keccak256(abi.encode(alice, uint32(1), uint32(2))));
    }

    function test_keyBindsCaller() public {
        int16[7] memory p = goodSpec();
        vm.prank(alice);
        ev.evaluate(1, 1, p, metaZero());
        // bob cannot look at alice's key: his key (bob,1,1) is unrecorded
        vm.prank(bob);
        vm.expectRevert(Evaluator.NotRecorded.selector);
        ev.confirm(1, 1, p);
        vm.prank(bob);
        vm.expectRevert(Evaluator.NotRecorded.selector);
        ev.sealedLook(1, 1, p);
        // and bob evaluating the same (gen, idx) writes a different slot
        vm.prank(bob);
        ev.evaluate(1, 1, p, metaZero());
        assertTrue(ledger.exists(ledger.keyOf(alice, 1, 1)));
        assertTrue(ledger.exists(ledger.keyOf(bob, 1, 1)));
    }
}
