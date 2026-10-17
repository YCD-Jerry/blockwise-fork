// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Base} from "./Base.sol";

contract GasTest is Base {
    function test_gasNumbers() public {
        int16[7] memory p = goodSpec();
        vm.startPrank(alice);
        uint256 g = gasleft();
        ev.evaluate(0, 0, p, metaZero());
        emit log_named_uint("gas evaluate (first call, cold)", g - gasleft());
        g = gasleft();
        ev.confirm(0, 0, p);
        emit log_named_uint("gas confirm", g - gasleft());
        g = gasleft();
        ev.sealedLook(0, 0, p);
        emit log_named_uint("gas sealedLook", g - gasleft());
        vm.stopPrank();
        g = gasleft();
        ev.score(p);
        emit log_named_uint("gas score", g - gasleft());
        g = gasleft();
        ev.score(p);
        emit log_named_uint("gas score (warm repeat)", g - gasleft());
        (int32 d, uint16 t) = ev.score(p);
        emit log_named_uint("trades in dev (loop branch weight)", t);
        d;
    }
}
