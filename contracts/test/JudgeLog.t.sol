// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Base} from "./Base.sol";
import {JudgeLog} from "../src/JudgeLog.sol";

contract JudgeLogTest is Base {
    JudgeLog jl;

    function setUp() public override {
        super.setUp();
        jl = new JudgeLog(ledger);
    }

    function test_predictAndGet() public {
        bytes32 k = ledger.keyOf(alice, 1, 1);
        vm.roll(777);
        vm.expectEmit(true, true, false, true);
        emit JudgeLog.Predicted(k, bob, -50, 6000);
        vm.prank(bob);
        jl.predict(k, -50, 6000);
        (int32 th, uint16 p, uint80 at, bool f) = jl.get(k, bob);
        assertEq(th, -50);
        assertEq(p, 6000);
        assertEq(at, 777);
        assertTrue(f);
        (,,, bool nf) = jl.get(k, alice);
        assertFalse(nf);
    }

    function test_badProbability() public {
        bytes32 k = ledger.keyOf(alice, 1, 1);
        jl.predict(k, 0, 10_000); // boundary ok
        vm.expectRevert(JudgeLog.BadProbability.selector);
        vm.prank(bob);
        jl.predict(k, 0, 10_001);
    }

    function test_alreadyPredicted() public {
        bytes32 k = ledger.keyOf(alice, 1, 1);
        jl.predict(k, 0, 100);
        vm.expectRevert(JudgeLog.AlreadyPredicted.selector);
        jl.predict(k, 5, 200);
        // a different judge may still predict
        vm.prank(bob);
        jl.predict(k, 5, 200);
    }

    function test_alreadyScored() public {
        vm.prank(alice);
        ev.evaluate(1, 1, goodSpec(), metaZero());
        bytes32 k = ledger.keyOf(alice, 1, 1);
        vm.expectRevert(JudgeLog.AlreadyScored.selector);
        jl.predict(k, 0, 5000);
    }

    function test_resolve() public {
        bytes32 k = ledger.keyOf(alice, 2, 2);
        (bool r0,,) = jl.resolve(k, bob);
        assertFalse(r0); // no prediction
        int16[7] memory p = goodSpec();
        (int32 dev,) = ev.score(p);
        vm.startPrank(bob);
        jl.predict(k, dev - 1, 7000); // dev > threshold -> true
        (bool r1,,) = jl.resolve(k, bob);
        assertFalse(r1); // not yet scored
        vm.stopPrank();
        vm.prank(alice);
        ev.evaluate(2, 2, p, metaZero());
        (bool r2, bool outcome, uint16 pb) = jl.resolve(k, bob);
        assertTrue(r2);
        assertTrue(outcome);
        assertEq(pb, 7000);

        bytes32 k2 = ledger.keyOf(alice, 3, 3);
        vm.prank(bob);
        jl.predict(k2, dev, 1000); // dev > dev is false
        vm.prank(alice);
        ev.evaluate(3, 3, p, metaZero());
        (bool r3, bool o3,) = jl.resolve(k2, bob);
        assertTrue(r3);
        assertFalse(o3);
    }
}
