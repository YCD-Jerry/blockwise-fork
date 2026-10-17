// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ledger} from "../src/Ledger.sol";
import {Evaluator} from "../src/Evaluator.sol";

abstract contract Base is Test {
    Ledger ledger;
    Evaluator ev;
    int16[] rets;
    uint16 devEnd;
    uint16 confirmEnd;
    string golden;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public virtual {
        golden = vm.readFile("../data/golden.json");
        int256[] memory r = vm.parseJsonIntArray(golden, ".returns");
        for (uint256 i; i < r.length; ++i) rets.push(int16(r[i]));
        devEnd = uint16(vm.parseJsonUint(golden, ".devEnd"));
        confirmEnd = uint16(vm.parseJsonUint(golden, ".confirmEnd"));
        ledger = new Ledger();
        ev = new Evaluator(ledger, rets, devEnd, confirmEnd);
        ledger.bind(address(ev));
    }

    function p7(int16 a, int16 b, int16 c, int16 d, int16 e, int16 f, int16 thr) internal pure returns (int16[7] memory p) {
        p = [a, b, c, d, e, f, thr];
    }

    function metaZero() internal pure returns (Evaluator.Meta memory) {
        return Evaluator.Meta(0, 0, 0);
    }

    /// A spec that trades on the golden series (non-trivial scores).
    function goodSpec() internal pure returns (int16[7] memory) {
        return p7(10, -5, 3, 2, -1, 1, 5);
    }
}
