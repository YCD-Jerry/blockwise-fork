// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Base} from "./Base.sol";
import {Evaluator} from "../src/Evaluator.sol";

contract GoldenTest is Base {
    function _spec(uint256 i) internal view returns (int16[7] memory p) {
        int256[] memory s = vm.parseJsonIntArray(golden, string.concat(".cases[", vm.toString(i), "].spec"));
        require(s.length == 7, "spec len");
        for (uint256 k; k < 7; ++k) p[k] = int16(s[k]);
    }

    function _i(uint256 i, string memory f) internal view returns (int256) {
        return vm.parseJsonInt(golden, string.concat(".cases[", vm.toString(i), "].", f));
    }

    function test_golden200() public {
        uint256 n = 200;
        // sanity on the file itself
        uint256 bad;
        for (uint256 i; i < n; ++i) {
            int16[7] memory p = _spec(i);
            (int32 d, uint16 dt) = ev.score(p);
            address who = address(uint160(0x1000 + i));
            vm.startPrank(who);
            int32 dEval = ev.evaluate(1, uint32(i), p, metaZero());
            int32 c = ev.confirm(1, uint32(i), p);
            int32 s = ev.sealedLook(1, uint32(i), p);
            vm.stopPrank();
            bytes32 k = ledger.keyOf(who, 1, uint32(i));
            (, , uint16 edt,,,) = ledger.getDev(k);
            (, uint16 ct,) = ledger.getConfirm(k);
            (, uint16 st,) = ledger.getSealed(k);
            bool ok = d == int32(_i(i, "dev")) && dEval == d && dt == uint16(uint256(_i(i, "devTrades"))) && edt == dt
                && c == int32(_i(i, "confirm")) && ct == uint16(uint256(_i(i, "confirmTrades")))
                && s == int32(_i(i, "sealed")) && st == uint16(uint256(_i(i, "sealedTrades")));
            if (!ok) {
                ++bad;
                emit log_named_uint("MISMATCH case", i);
            }
        }
        assertEq(bad, 0, "golden mismatches");
    }

    function test_goldenHasNonTrivialCases() public view {
        uint256 nonzero;
        for (uint256 i; i < 200; ++i) {
            if (_i(i, "devTrades") > 0) ++nonzero;
        }
        assertGt(nonzero, 50);
    }
}
