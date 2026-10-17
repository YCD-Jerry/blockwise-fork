// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Ledger} from "./Ledger.sol";

/// @title Evaluator
/// @notice The fixed judge. Scores a tiny trading strategy against a frozen return series, in integers only.
///
/// A strategy is 7 small integers (the "spec"):
///   p[0..5]  weights on the last six returns, each in [-64, 63]
///   p[6]     threshold in [0, 8191]
/// At step t the signal is s_t = sum_k p[k] * r[t-k]. Position is +1 if s_t > thr, -1 if s_t < -thr, else 0.
/// The position taken at t earns r[t+1], and every change of position pays COST_BPS per unit changed.
/// Score = total PnL in basis points. See docs/architecture.md, "Strategy semantics" (the spec of record).
///
/// The series is split into three roles, as in ants:
///   dev      earn range [FIRST_EARN, devEnd)        many looks, used by search
///   confirm  earn range [devEnd, confirmEnd)        one recorded look per candidate
///   sealed   earn range [confirmEnd, length)        one recorded look per candidate, by its proposer only
///
/// Proposers choose a spec and submit it. They never write a score: only this contract can write the Ledger.
contract Evaluator {
    error BadParam(uint8 index);
    error BadSeries();
    error NotRecorded();
    error ParamsMismatch();

    uint8 public constant LAGS = 6;
    uint8 public constant PARAMS = 7;
    uint8 public constant COST_BPS = 3;
    uint16 public constant FIRST_EARN = 6; // first decision at t = 5 earns r[6]
    int16 public constant W_MIN = -64;
    int16 public constant W_MAX = 63;
    int16 public constant THR_MAX = 8191;
    uint16 public constant SPEC_VERSION = 1;

    Ledger public immutable ledger;
    uint16 public immutable length;
    uint16 public immutable devEnd;
    uint16 public immutable confirmEnd;
    /// @notice Identity of the judge: series, split, cost and spec version. A different epoch is a different experiment.
    bytes32 public immutable epoch;

    /// @dev 16 int16 returns per word, element i at bits [16*(i%16), 16*(i%16)+16).
    uint256[] private _words;

    struct Meta {
        uint8 operator; // which search operator proposed this spec (lineage credit)
        uint32 parentGen; // lineage; 0/0 means no parent
        uint32 parentIdx;
    }

    event Evaluated(
        uint32 indexed gen,
        uint32 indexed idx,
        address indexed proposer,
        int32 dev,
        uint16 trades,
        uint8 operator,
        uint32 parentGen,
        uint32 parentIdx,
        int16[7] params
    );
    event Confirmed(uint32 indexed gen, uint32 indexed idx, address indexed proposer, int32 score, uint16 trades);
    event Sealed(uint32 indexed gen, uint32 indexed idx, address indexed proposer, int32 score, uint16 trades);

    constructor(Ledger ledger_, int16[] memory returns_, uint16 devEnd_, uint16 confirmEnd_) {
        uint256 n = returns_.length;
        if (n > type(uint16).max || devEnd_ <= FIRST_EARN + LAGS || confirmEnd_ <= devEnd_ || confirmEnd_ + 1 >= n) {
            revert BadSeries();
        }

        ledger = ledger_;
        length = uint16(n);
        devEnd = devEnd_;
        confirmEnd = confirmEnd_;

        uint256 words = (n + 15) / 16;
        for (uint256 w = 0; w < words; ++w) {
            uint256 packed;
            for (uint256 j = 0; j < 16; ++j) {
                uint256 i = w * 16 + j;
                if (i >= n) break;
                packed |= uint256(uint16(returns_[i])) << (16 * j);
            }
            _words.push(packed);
        }
        epoch = keccak256(abi.encode(SPEC_VERSION, COST_BPS, devEnd_, confirmEnd_, returns_));
    }

    // ------------------------------------------------------------------ search

    /// @notice Score `p` on the dev range and write the result to the Ledger. Callable by anyone; the key binds the caller.
    function evaluate(uint32 gen, uint32 idx, int16[7] calldata p, Meta calldata m) external returns (int32 dev) {
        _validate(p);
        uint16 trades;
        (dev, trades) = _run(p, FIRST_EARN, devEnd);
        ledger.recordDev(_key(msg.sender, gen, idx), msg.sender, dev, trades, m.operator, _hash40(p));
        emit Evaluated(gen, idx, msg.sender, dev, trades, m.operator, m.parentGen, m.parentIdx, p);
    }

    /// @notice Free dry-run on the dev range. Writes nothing; used by cheap pre-screens and tests.
    function score(int16[7] calldata p) external view returns (int32 dev, uint16 trades) {
        _validate(p);
        return _run(p, FIRST_EARN, devEnd);
    }

    // ------------------------------------------------------------- later looks

    /// @notice One recorded look at the confirm range, by the proposer of an already-evaluated spec.
    function confirm(uint32 gen, uint32 idx, int16[7] calldata p) external returns (int32 s) {
        bytes32 key = _bound(gen, idx, p);
        uint16 trades;
        (s, trades) = _run(p, devEnd, confirmEnd);
        ledger.recordConfirm(key, s, trades);
        emit Confirmed(gen, idx, msg.sender, s, trades);
    }

    /// @notice The one recorded look at the sealed range. Only the proposer can spend it, and only once per spec.
    function sealedLook(uint32 gen, uint32 idx, int16[7] calldata p) external returns (int32 s) {
        bytes32 key = _bound(gen, idx, p);
        uint16 trades;
        (s, trades) = _run(p, confirmEnd, length);
        ledger.recordSealed(key, s, trades);
        emit Sealed(gen, idx, msg.sender, s, trades);
    }

    // --------------------------------------------------------------- internals

    function _key(address proposer, uint32 gen, uint32 idx) private pure returns (bytes32) {
        return keccak256(abi.encode(proposer, gen, idx));
    }

    function _hash40(int16[7] calldata p) private pure returns (uint40) {
        return uint40(uint256(keccak256(abi.encode(p))) >> 216);
    }

    /// @dev The spec must be the one that was evaluated, and the caller must be its proposer (key binds the caller).
    function _bound(uint32 gen, uint32 idx, int16[7] calldata p) private view returns (bytes32 key) {
        _validate(p);
        key = _key(msg.sender, gen, idx);
        (,,,, uint40 h, bool found) = ledger.getDev(key);
        if (!found) revert NotRecorded();
        if (h != _hash40(p)) revert ParamsMismatch();
    }

    /// @dev The typed grammar: the only door for specs. Out-of-range specs revert, they are never clamped.
    function _validate(int16[7] calldata p) private pure {
        for (uint8 k = 0; k < LAGS; ++k) {
            if (p[k] < W_MIN || p[k] > W_MAX) revert BadParam(k);
        }
        if (p[6] < 0 || p[6] > THR_MAX) revert BadParam(6);
    }

    /// @dev Reads one return straight from the packed words (no memory copy of the whole series).
    function _r(uint256 i) private view returns (int256) {
        return int256(int16(uint16(_words[i >> 4] >> ((i & 15) << 4))));
    }

    /// @dev Walk-forward over earn range [lo, hi): the decision at t uses r[t-5..t] and earns r[t+1].
    /// Rolling window: a0 = r[t], a1 = r[t-1], ... a5 = r[t-5]; one new return is read per step.
    function _run(int16[7] calldata p, uint256 lo, uint256 hi) private view returns (int32 pnl, uint16 trades) {
        int256 w0 = p[0];
        int256 w1 = p[1];
        int256 w2 = p[2];
        int256 w3 = p[3];
        int256 w4 = p[4];
        int256 w5 = p[5];
        int256 thr = p[6];

        int256 a0 = _r(lo - 1);
        int256 a1 = _r(lo - 2);
        int256 a2 = _r(lo - 3);
        int256 a3 = _r(lo - 4);
        int256 a4 = _r(lo - 5);
        int256 a5 = _r(lo - 6);

        int256 prev;
        int256 acc;
        uint256 count;
        uint256 wi = type(uint256).max; // index of the cached packed word
        uint256 cw;
        unchecked {
            for (uint256 e = lo; e < hi; ++e) {
                int256 s = w0 * a0 + w1 * a1 + w2 * a2 + w3 * a3 + w4 * a4 + w5 * a5;
                int256 pos = s > thr ? int256(1) : (s < -thr ? int256(-1) : int256(0));
                if (e >> 4 != wi) {
                    wi = e >> 4;
                    cw = _words[wi]; // one SLOAD per 16 returns
                }
                int256 re = int256(int16(uint16(cw >> ((e & 15) << 4)))); // r[t+1], earned by the decision at t = e-1
                acc += pos * re;
                if (pos != prev) {
                    int256 d = pos - prev;
                    acc -= int256(uint256(COST_BPS)) * (d < 0 ? -d : d);
                    ++count;
                    prev = pos;
                }
                a5 = a4;
                a4 = a3;
                a3 = a2;
                a2 = a1;
                a1 = a0;
                a0 = re;
            }
        } // unchecked: |w|<=64, |r|<=32768, <=65535 steps, so every intermediate fits int256 with huge margin
        pnl = int32(acc);
        trades = uint16(count);
    }
}
