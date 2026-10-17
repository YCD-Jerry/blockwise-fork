# ABI notes (for viem `parseAbi`)

Status: Ledger, Evaluator, JudgeLog implemented and tested. Allocator implemented and tested (fuzz + invariant green), NOT yet deployed.
Types: `int16[7]` is a fixed array. `Meta` is the tuple `(uint8 operator, uint32 parentGen, uint32 parentIdx)`.

## Ledger
```
constructor()
function bind(address evaluator_)
function owner() view returns (address)
function evaluator() view returns (address)
function recordDev(bytes32 key, address proposer, int32 dev, uint16 trades, uint8 operator, uint40 paramsHash)
function recordConfirm(bytes32 key, int32 score, uint16 trades)
function recordSealed(bytes32 key, int32 score, uint16 trades)
function keyOf(address proposer, uint32 gen, uint32 idx) pure returns (bytes32)
function exists(bytes32 key) view returns (bool)
function getDev(bytes32 key) view returns (address proposer, int32 dev, uint16 trades, uint8 operator, uint40 paramsHash, bool found)
function getConfirm(bytes32 key) view returns (int32 score, uint16 trades, bool found)
function getSealed(bytes32 key) view returns (int32 score, uint16 trades, bool found)
error NotOwner()
error NotEvaluator()
error AlreadyBound()
error AlreadyRecorded()
error NotRecorded()
```
(Ledger has no events; read via the Evaluator events.)

## Evaluator
```
constructor(address ledger_, int16[] returns_, uint16 devEnd_, uint16 confirmEnd_)
function evaluate(uint32 gen, uint32 idx, int16[7] p, (uint8 operator, uint32 parentGen, uint32 parentIdx) m) returns (int32 dev)
function score(int16[7] p) view returns (int32 dev, uint16 trades)
function confirm(uint32 gen, uint32 idx, int16[7] p) returns (int32 s)
function sealedLook(uint32 gen, uint32 idx, int16[7] p) returns (int32 s)
function ledger() view returns (address)
function length() view returns (uint16)
function devEnd() view returns (uint16)
function confirmEnd() view returns (uint16)
function epoch() view returns (bytes32)
function LAGS() view returns (uint8)
function PARAMS() view returns (uint8)
function COST_BPS() view returns (uint8)
function FIRST_EARN() view returns (uint16)
function W_MIN() view returns (int16)
function W_MAX() view returns (int16)
function THR_MAX() view returns (int16)
function SPEC_VERSION() view returns (uint16)
event Evaluated(uint32 indexed gen, uint32 indexed idx, address indexed proposer, int32 dev, uint16 trades, uint8 operator, uint32 parentGen, uint32 parentIdx, int16[7] params)
event Confirmed(uint32 indexed gen, uint32 indexed idx, address indexed proposer, int32 score, uint16 trades)
event Sealed(uint32 indexed gen, uint32 indexed idx, address indexed proposer, int32 score, uint16 trades)
error BadParam(uint8 index)
error BadSeries()
error NotRecorded()
error ParamsMismatch()
```
Ledger errors (`AlreadyRecorded`, `NotEvaluator`) bubble up through Evaluator calls.

## JudgeLog
```
constructor(address ledger_)
function ledger() view returns (address)
function predict(bytes32 key, int32 threshold, uint16 pBps)
function get(bytes32 key, address judge) view returns (int32 threshold, uint16 pBps, uint80 atBlock, bool found)
function resolve(bytes32 key, address judge) view returns (bool resolved, bool outcome, uint16 pBps)
event Predicted(bytes32 indexed key, address indexed judge, int32 threshold, uint16 pBps)
error AlreadyScored()
error AlreadyPredicted()
error BadProbability()
```

## Allocator (status: tested, not deployed)
```
constructor(address ledger_)
function ledger() view returns (address)
function deposit() payable
function allocate(bytes32 agentKey, uint256 amount)
function unallocate(bytes32 agentKey, uint256 amount)
function reallocate(bytes32 fromKey, bytes32 toKey, uint256 amount)
function withdraw(uint256 amount)
function freeBalance(address user) view returns (uint256)
function agentTotal(bytes32 agentKey) view returns (uint256)
function allocationOf(address user, bytes32 agentKey) view returns (uint256)
function userAllocated(address user) view returns (uint256)
function totalDeposited() view returns (uint256)
event Deposited(address indexed user, uint256 amount)
event Allocated(address indexed user, bytes32 indexed agentKey, uint256 amount)
event Unallocated(address indexed user, bytes32 indexed agentKey, uint256 amount)
event Withdrawn(address indexed user, uint256 amount)
error NotEnough()
error UnknownAgent()
error NotConfirmed()
error Reentrancy()
error TransferFailed()
```
Semantics: `withdraw` pays only from the caller's free balance; allocations are separate and never block it. `totalDeposited` = MON currently held (free + allocated). Key for an agent: `Ledger.keyOf(proposer, gen, idx)`.
