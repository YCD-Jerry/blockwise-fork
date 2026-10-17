// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Ledger} from "./Ledger.sol";

/// @title Allocator
/// @notice Testnet escrow for funding agents (docs/architecture.md 3b). Test MON, virtual, no payout.
/// Never writes the Ledger, never influences a score, pays only the depositor.
/// No owner, no pause, no proxy, no oracle: `withdraw` can never be blocked by anyone else.
/// Allocations are bookkeeping weights kept separate from the free balance; both are the depositor's own MON.
contract Allocator {
    error NotEnough();
    error UnknownAgent();
    error NotConfirmed();
    error Reentrancy();
    error TransferFailed();

    Ledger public immutable ledger;

    mapping(address user => uint256) private _free;
    mapping(address user => uint256) private _userAllocated;
    mapping(address user => mapping(bytes32 key => uint256)) private _alloc;
    mapping(bytes32 key => uint256) private _agentTotal;
    uint256 private _held;
    uint256 private _lock = 1;

    event Deposited(address indexed user, uint256 amount);
    event Allocated(address indexed user, bytes32 indexed agentKey, uint256 amount);
    event Unallocated(address indexed user, bytes32 indexed agentKey, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);

    constructor(Ledger ledger_) {
        ledger = ledger_;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    function deposit() external payable {
        _free[msg.sender] += msg.value;
        _held += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    function allocate(bytes32 agentKey, uint256 amount) external {
        _requireFundable(agentKey);
        uint256 f = _free[msg.sender];
        if (amount > f) revert NotEnough();
        _free[msg.sender] = f - amount;
        _add(msg.sender, agentKey, amount);
        emit Allocated(msg.sender, agentKey, amount);
    }

    function unallocate(bytes32 agentKey, uint256 amount) external {
        _sub(msg.sender, agentKey, amount);
        _free[msg.sender] += amount;
        emit Unallocated(msg.sender, agentKey, amount);
    }

    function reallocate(bytes32 fromKey, bytes32 toKey, uint256 amount) external {
        _requireFundable(toKey);
        _sub(msg.sender, fromKey, amount);
        _add(msg.sender, toKey, amount);
        emit Unallocated(msg.sender, fromKey, amount);
        emit Allocated(msg.sender, toKey, amount);
    }

    /// @notice Pays `amount` of the caller's FREE balance to the caller. Always callable; allocations do not block it.
    function withdraw(uint256 amount) external nonReentrant {
        uint256 f = _free[msg.sender];
        if (amount > f) revert NotEnough();
        _free[msg.sender] = f - amount; // effects before interaction
        _held -= amount;
        emit Withdrawn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ----------------------------------------------------------------- views

    /// @notice Free (withdrawable) balance of `user`.
    function freeBalance(address user) external view returns (uint256) {
        return _free[user];
    }

    /// @notice Total allocated to `agentKey` by everyone.
    function agentTotal(bytes32 agentKey) external view returns (uint256) {
        return _agentTotal[agentKey];
    }

    /// @notice What `user` has allocated to `agentKey`.
    function allocationOf(address user, bytes32 agentKey) external view returns (uint256) {
        return _alloc[user][agentKey];
    }

    /// @notice Sum of everything `user` has allocated across agents.
    function userAllocated(address user) external view returns (uint256) {
        return _userAllocated[user];
    }

    /// @notice MON currently held: all free balances plus all allocations (deposits minus withdrawals).
    function totalDeposited() external view returns (uint256) {
        return _held;
    }

    // -------------------------------------------------------------- internals

    function _requireFundable(bytes32 key) private view {
        if (!ledger.exists(key)) revert UnknownAgent();
        (,, bool found) = ledger.getConfirm(key);
        if (!found) revert NotConfirmed();
    }

    function _add(address user, bytes32 key, uint256 amount) private {
        _alloc[user][key] += amount;
        _agentTotal[key] += amount;
        _userAllocated[user] += amount;
    }

    function _sub(address user, bytes32 key, uint256 amount) private {
        uint256 a = _alloc[user][key];
        if (amount > a) revert NotEnough();
        _alloc[user][key] = a - amount;
        _agentTotal[key] -= amount;
        _userAllocated[user] -= amount;
    }
}
