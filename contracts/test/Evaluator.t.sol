// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Base} from "./Base.sol";
import {Ledger} from "../src/Ledger.sol";
import {Evaluator} from "../src/Evaluator.sol";

contract EvaluatorTest is Base {
    function test_confirmParamsMismatch() public {
        int16[7] memory p = goodSpec();
        int16[7] memory q = goodSpec();
        q[0] = 11;
        vm.startPrank(alice);
        ev.evaluate(3, 4, p, metaZero());
        vm.expectRevert(Evaluator.ParamsMismatch.selector);
        ev.confirm(3, 4, q);
        vm.expectRevert(Evaluator.ParamsMismatch.selector);
        ev.sealedLook(3, 4, q);
        vm.stopPrank();
    }

    function test_confirmSealedNotRecorded() public {
        int16[7] memory p = goodSpec();
        vm.startPrank(alice);
        vm.expectRevert(Evaluator.NotRecorded.selector);
        ev.confirm(9, 9, p);
        vm.expectRevert(Evaluator.NotRecorded.selector);
        ev.sealedLook(9, 9, p);
        vm.stopPrank();
    }

    function test_looksAreIndependentAndRecorded() public {
        int16[7] memory p = goodSpec();
        vm.startPrank(alice);
        int32 d = ev.evaluate(0, 0, p, metaZero());
        int32 c = ev.confirm(0, 0, p);
        int32 s = ev.sealedLook(0, 0, p);
        vm.stopPrank();
        bytes32 k = ledger.keyOf(alice, 0, 0);
        (, int32 ld,,,, bool f) = ledger.getDev(k);
        (int32 lc,, bool cf) = ledger.getConfirm(k);
        (int32 ls,, bool sf) = ledger.getSealed(k);
        assertTrue(f && cf && sf);
        assertEq(ld, d);
        assertEq(lc, c);
        assertEq(ls, s);
    }

    function test_evaluateEqualsScore() public {
        int16[7] memory p = goodSpec();
        (int32 sd, uint16 st) = ev.score(p);
        vm.prank(alice);
        int32 d = ev.evaluate(0, 1, p, metaZero());
        (, int32 ld, uint16 lt,,,) = ledger.getDev(ledger.keyOf(alice, 0, 1));
        assertEq(d, sd);
        assertEq(ld, sd);
        assertEq(lt, st);
    }

    function test_evaluatedEventAndMeta() public {
        int16[7] memory p = goodSpec();
        (int32 sd, uint16 st) = ev.score(p);
        vm.expectEmit(true, true, true, true);
        emit Evaluator.Evaluated(5, 6, alice, sd, st, 2, 4, 3, p);
        vm.prank(alice);
        ev.evaluate(5, 6, p, Evaluator.Meta(2, 4, 3));
        (,,, uint8 op,,) = ledger.getDev(ledger.keyOf(alice, 5, 6));
        assertEq(op, 2);
    }

    function test_epoch() public view {
        bytes32 expect = keccak256(abi.encode(uint16(1), uint8(3), devEnd, confirmEnd, rets));
        assertEq(ev.epoch(), expect);
        assertEq(ev.SPEC_VERSION(), 1);
        assertEq(ev.COST_BPS(), 3);
        assertEq(ev.length(), rets.length);
    }

    function test_epochChangesWithSeries() public {
        int16[] memory r2 = rets;
        r2[10] = r2[10] + 1;
        Evaluator e2 = new Evaluator(ledger, r2, devEnd, confirmEnd);
        assertTrue(e2.epoch() != ev.epoch());
    }

    function test_badSeries() public {
        vm.expectRevert(Evaluator.BadSeries.selector);
        new Evaluator(ledger, rets, 12, confirmEnd); // devEnd must be > FIRST_EARN + LAGS
        vm.expectRevert(Evaluator.BadSeries.selector);
        new Evaluator(ledger, rets, devEnd, devEnd); // confirmEnd > devEnd
        vm.expectRevert(Evaluator.BadSeries.selector);
        new Evaluator(ledger, rets, devEnd, uint16(rets.length - 1)); // confirmEnd + 1 < N
        // boundary accepted
        new Evaluator(ledger, rets, 13, uint16(rets.length - 2));
    }

    function test_zeroSpecNeverTrades() public view {
        (int32 d, uint16 t) = ev.score(p7(0, 0, 0, 0, 0, 0, 0));
        assertEq(d, 0);
        assertEq(t, 0);
    }

    // ---------------------------------------------------------- grammar bounds

    function _call(int16[7] memory p) external view returns (int32, uint16) {
        return ev.score(p);
    }

    function test_badParamEveryIndexBothBoundsAndOutside() public {
        for (uint8 k = 0; k < 7; ++k) {
            int16 lo = k < 6 ? int16(-64) : int16(0);
            int16 hi = k < 6 ? int16(63) : int16(8191);
            // exactly at bounds: valid
            int16[7] memory p = goodSpec();
            p[k] = lo;
            ev.score(p);
            p[k] = hi;
            ev.score(p);
            // just outside: BadParam(k), via score() and via evaluate()
            p[k] = lo - 1;
            vm.expectRevert(abi.encodeWithSelector(Evaluator.BadParam.selector, k));
            ev.score(p);
            vm.prank(alice);
            vm.expectRevert(abi.encodeWithSelector(Evaluator.BadParam.selector, k));
            ev.evaluate(uint32(k), 0, p, metaZero());
            p[k] = hi + 1;
            vm.expectRevert(abi.encodeWithSelector(Evaluator.BadParam.selector, k));
            ev.score(p);
            vm.prank(alice);
            vm.expectRevert(abi.encodeWithSelector(Evaluator.BadParam.selector, k));
            ev.evaluate(uint32(k), 1, p, metaZero());
            // extremes of int16
            p[k] = type(int16).min;
            vm.expectRevert(abi.encodeWithSelector(Evaluator.BadParam.selector, k));
            ev.score(p);
            p[k] = type(int16).max;
            vm.expectRevert(abi.encodeWithSelector(Evaluator.BadParam.selector, k));
            ev.score(p);
        }
    }

    function test_badParamBlocksLooksAndWritesNothing() public {
        int16[7] memory p = goodSpec();
        vm.startPrank(alice);
        ev.evaluate(0, 0, p, metaZero());
        p[3] = 64;
        vm.expectRevert(abi.encodeWithSelector(Evaluator.BadParam.selector, uint8(3)));
        ev.confirm(0, 0, p);
        vm.expectRevert(abi.encodeWithSelector(Evaluator.BadParam.selector, uint8(3)));
        ev.sealedLook(0, 0, p);
        vm.stopPrank();
        assertFalse(ledger.exists(ledger.keyOf(alice, 7, 7)));
    }
}
