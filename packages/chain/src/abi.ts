// Hand-written from contracts/src/*.sol (Allocator: add from contracts/ABI_NOTES.md when it exists).
import { parseAbi } from "viem";

export const ledgerAbi = parseAbi([
  "function owner() view returns (address)",
  "function evaluator() view returns (address)",
  "function bind(address evaluator_)",
  "function keyOf(address proposer, uint32 gen, uint32 idx) pure returns (bytes32)",
  "function exists(bytes32 key) view returns (bool)",
  "function getDev(bytes32 key) view returns (address proposer, int32 dev, uint16 trades, uint8 operator, uint40 paramsHash, bool found)",
  "function getConfirm(bytes32 key) view returns (int32 score, uint16 trades, bool found)",
  "function getSealed(bytes32 key) view returns (int32 score, uint16 trades, bool found)",
]);

export const evaluatorAbi = parseAbi([
  "function ledger() view returns (address)",
  "function length() view returns (uint16)",
  "function devEnd() view returns (uint16)",
  "function confirmEnd() view returns (uint16)",
  "function epoch() view returns (bytes32)",
  "function SPEC_VERSION() view returns (uint16)",
  "function COST_BPS() view returns (uint8)",
  "function score(int16[7] p) view returns (int32 dev, uint16 trades)",
  "function evaluate(uint32 gen, uint32 idx, int16[7] p, (uint8 operator, uint32 parentGen, uint32 parentIdx) m) returns (int32 dev)",
  "function confirm(uint32 gen, uint32 idx, int16[7] p) returns (int32 s)",
  "function sealedLook(uint32 gen, uint32 idx, int16[7] p) returns (int32 s)",
  "event Evaluated(uint32 indexed gen, uint32 indexed idx, address indexed proposer, int32 dev, uint16 trades, uint8 operator, uint32 parentGen, uint32 parentIdx, int16[7] params)",
  "event Confirmed(uint32 indexed gen, uint32 indexed idx, address indexed proposer, int32 score, uint16 trades)",
  "event Sealed(uint32 indexed gen, uint32 indexed idx, address indexed proposer, int32 score, uint16 trades)",
]);

export const judgeLogAbi = parseAbi([
  "function ledger() view returns (address)",
  "function predict(bytes32 key, int32 threshold, uint16 pBps)",
  "function get(bytes32 key, address judge) view returns (int32 threshold, uint16 pBps, uint80 atBlock, bool found)",
  "function resolve(bytes32 key, address judge) view returns (bool resolved, bool outcome, uint16 pBps)",
  "event Predicted(bytes32 indexed key, address indexed judge, int32 threshold, uint16 pBps)",
]);

// Allocator: tested, NOT deployed by `deploy` (docs/contracts.md; deploy only with its tests green).
export const allocatorAbi = parseAbi([
  "function ledger() view returns (address)",
  "function deposit() payable",
  "function allocate(bytes32 agentKey, uint256 amount)",
  "function unallocate(bytes32 agentKey, uint256 amount)",
  "function reallocate(bytes32 fromKey, bytes32 toKey, uint256 amount)",
  "function withdraw(uint256 amount)",
  "function freeBalance(address user) view returns (uint256)",
  "function agentTotal(bytes32 agentKey) view returns (uint256)",
  "function allocationOf(address user, bytes32 agentKey) view returns (uint256)",
  "function userAllocated(address user) view returns (uint256)",
  "function totalDeposited() view returns (uint256)",
  "event Deposited(address indexed user, uint256 amount)",
  "event Allocated(address indexed user, bytes32 indexed agentKey, uint256 amount)",
  "event Unallocated(address indexed user, bytes32 indexed agentKey, uint256 amount)",
  "event Withdrawn(address indexed user, uint256 amount)",
]);
