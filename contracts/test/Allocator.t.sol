// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Ledger} from "../src/Ledger.sol";
import {Allocator} from "../src/Allocator.sol";

/// Stands in for the bound Evaluator so tests can create dev/confirm records directly.
contract FakeEvaluator {
    Ledger public l;

    constructor(Ledger l_) {
        l = l_;
    }

    function dev(bytes32 k, address p) external {
        l.recordDev(k, p, 1, 1, 0, 1);
    }

    function confirmed(bytes32 k) external {
        l.recordConfirm(k, 1, 1);
    }
}

contract Attacker {
    Allocator public a;
    uint256 public reenterTries;
    bool public swallow;
    bool public reenterFailed;

    constructor(Allocator a_, bool swallow_) {
        a = a_;
        swallow = swallow_;
    }

    function fund() external payable {
        a.deposit{value: msg.value}();
    }

    function attack(uint256 amt) external {
        a.withdraw(amt);
    }

    receive() external payable {
        if (reenterTries++ == 0) {
            if (swallow) {
                try a.withdraw(msg.value) {} catch { reenterFailed = true; }
            } else {
                a.withdraw(msg.value);
            }
        }
    }
}

contract Rejecter {
    function dep(Allocator a) external payable {
        a.deposit{value: msg.value}();
    }

    function wd(Allocator a, uint256 x) external {
        a.withdraw(x);
    }
    // no receive: payouts to this contract fail
}

abstract contract AllocBase is Test {
    Ledger ledger;
    FakeEvaluator fe;
    Allocator al;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    bytes32 kConfirmed = keccak256("confirmed");
    bytes32 kConfirmed2 = keccak256("confirmed2");
    bytes32 kDevOnly = keccak256("devonly");
    bytes32 kUnknown = keccak256("unknown");

    function setUp() public virtual {
        ledger = new Ledger();
        fe = new FakeEvaluator(ledger);
        ledger.bind(address(fe));
        al = new Allocator(ledger);
        fe.dev(kConfirmed, alice);
        fe.confirmed(kConfirmed);
        fe.dev(kConfirmed2, bob);
        fe.confirmed(kConfirmed2);
        fe.dev(kDevOnly, alice);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }
}

contract AllocatorTest is AllocBase {
    event Deposited(address indexed user, uint256 amount);
    event Allocated(address indexed user, bytes32 indexed agentKey, uint256 amount);
    event Unallocated(address indexed user, bytes32 indexed agentKey, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);

    function test_depositAllocateViews() public {
        vm.startPrank(alice);
        vm.expectEmit(true, false, false, true);
        emit Deposited(alice, 10 ether);
        al.deposit{value: 10 ether}();
        vm.expectEmit(true, true, false, true);
        emit Allocated(alice, kConfirmed, 4 ether);
        al.allocate(kConfirmed, 4 ether);
        vm.stopPrank();
        assertEq(al.freeBalance(alice), 6 ether);
        assertEq(al.allocationOf(alice, kConfirmed), 4 ether);
        assertEq(al.agentTotal(kConfirmed), 4 ether);
        assertEq(al.userAllocated(alice), 4 ether);
        assertEq(al.totalDeposited(), 10 ether);
        assertEq(address(al).balance, 10 ether);
    }

    function test_unknownAgentReverts() public {
        vm.startPrank(alice);
        al.deposit{value: 1 ether}();
        vm.expectRevert(Allocator.UnknownAgent.selector);
        al.allocate(kUnknown, 1);
        vm.expectRevert(Allocator.UnknownAgent.selector);
        al.reallocate(kConfirmed, kUnknown, 0);
        vm.stopPrank();
    }

    function test_unconfirmedAgentReverts() public {
        vm.startPrank(alice);
        al.deposit{value: 1 ether}();
        vm.expectRevert(Allocator.NotConfirmed.selector);
        al.allocate(kDevOnly, 1);
        vm.expectRevert(Allocator.NotConfirmed.selector);
        al.reallocate(kConfirmed, kDevOnly, 0);
        vm.stopPrank();
    }

    function test_allocateMoreThanFreeReverts() public {
        vm.startPrank(alice);
        al.deposit{value: 1 ether}();
        vm.expectRevert(Allocator.NotEnough.selector);
        al.allocate(kConfirmed, 1 ether + 1);
        vm.stopPrank();
    }

    function test_unallocateAndReallocate() public {
        vm.startPrank(alice);
        al.deposit{value: 10 ether}();
        al.allocate(kConfirmed, 5 ether);
        al.reallocate(kConfirmed, kConfirmed2, 2 ether);
        assertEq(al.allocationOf(alice, kConfirmed), 3 ether);
        assertEq(al.allocationOf(alice, kConfirmed2), 2 ether);
        vm.expectRevert(Allocator.NotEnough.selector);
        al.reallocate(kConfirmed, kConfirmed2, 3 ether + 1);
        vm.expectRevert(Allocator.NotEnough.selector);
        al.unallocate(kConfirmed, 3 ether + 1);
        vm.expectEmit(true, true, false, true);
        emit Unallocated(alice, kConfirmed, 3 ether);
        al.unallocate(kConfirmed, 3 ether);
        vm.stopPrank();
        assertEq(al.freeBalance(alice), 8 ether);
        assertEq(al.userAllocated(alice), 2 ether);
        assertEq(al.agentTotal(kConfirmed), 0);
    }

    function test_cannotTouchOthersAllocation() public {
        vm.prank(alice);
        al.deposit{value: 5 ether}();
        vm.prank(alice);
        al.allocate(kConfirmed, 5 ether);
        vm.startPrank(bob);
        vm.expectRevert(Allocator.NotEnough.selector);
        al.unallocate(kConfirmed, 1);
        vm.expectRevert(Allocator.NotEnough.selector);
        al.reallocate(kConfirmed, kConfirmed2, 1);
        vm.expectRevert(Allocator.NotEnough.selector);
        al.withdraw(1);
        vm.stopPrank();
    }

    function test_onlyDepositorPaid() public {
        vm.prank(alice);
        al.deposit{value: 3 ether}();
        vm.prank(bob);
        al.deposit{value: 2 ether}();
        uint256 a0 = alice.balance;
        uint256 b0 = bob.balance;
        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit Withdrawn(alice, 3 ether);
        al.withdraw(3 ether);
        assertEq(alice.balance, a0 + 3 ether);
        assertEq(bob.balance, b0);
        assertEq(address(al).balance, 2 ether);
        // alice has nothing left; she cannot pull bob's funds
        vm.prank(alice);
        vm.expectRevert(Allocator.NotEnough.selector);
        al.withdraw(1);
        assertEq(al.freeBalance(bob), 2 ether);
    }

    function test_withdrawAlwaysWorksWithAllocationsOutstanding() public {
        vm.startPrank(alice);
        al.deposit{value: 10 ether}();
        al.allocate(kConfirmed, 7 ether);
        al.withdraw(3 ether); // all free balance
        vm.expectRevert(Allocator.NotEnough.selector);
        al.withdraw(1); // allocations are separate
        al.unallocate(kConfirmed, 7 ether);
        al.withdraw(7 ether);
        vm.stopPrank();
        assertEq(address(al).balance, 0);
        assertEq(al.totalDeposited(), 0);
    }

    function test_noOwnerNoAdminSurface() public view {
        // The ABI exposes no privileged function; the only external state is the immutable ledger.
        assertEq(address(al.ledger()), address(ledger));
    }

    function test_neverWritesLedger() public {
        vm.startPrank(alice);
        al.deposit{value: 1 ether}();
        al.allocate(kConfirmed, 1 ether);
        vm.stopPrank();
        (, int32 dev,,,, bool f) = ledger.getDev(kConfirmed);
        assertTrue(f);
        assertEq(dev, 1);
        // Allocator is not the bound evaluator
        vm.prank(address(al));
        vm.expectRevert(Ledger.NotEvaluator.selector);
        ledger.recordConfirm(kConfirmed2, 1, 1);
    }

    function test_reentrancyAttackFails() public {
        Attacker at = new Attacker(al, false);
        vm.deal(address(at), 5 ether);
        at.fund{value: 5 ether}();
        vm.prank(alice);
        al.deposit{value: 5 ether}(); // honest funds the attacker would love
        vm.expectRevert(Allocator.TransferFailed.selector); // inner reentrant call reverts, outer payout fails
        at.attack(5 ether);
        assertEq(address(al).balance, 10 ether);
        assertEq(al.freeBalance(address(at)), 5 ether);
        assertEq(al.freeBalance(alice), 5 ether);
    }

    function test_reentrancyAttemptSwallowedPaysOnce() public {
        Attacker at = new Attacker(al, true);
        vm.deal(address(at), 5 ether);
        at.fund{value: 5 ether}();
        vm.prank(alice);
        al.deposit{value: 5 ether}();
        uint256 before = address(at).balance;
        at.attack(5 ether);
        assertTrue(at.reenterFailed());
        assertEq(address(at).balance, before + 5 ether); // paid exactly once
        assertEq(address(al).balance, 5 ether);
        assertEq(al.freeBalance(alice), 5 ether);
    }

    function test_rejectingReceiverCannotLoseFunds() public {
        Rejecter r = new Rejecter();
        vm.deal(address(r), 1 ether);
        r.dep{value: 1 ether}(al);
        vm.expectRevert(Allocator.TransferFailed.selector);
        r.wd(al, 1 ether);
        assertEq(al.freeBalance(address(r)), 1 ether); // state rolled back, funds intact
    }

    function testFuzz_depositWithdrawRoundTrip(uint96 amt) public {
        vm.assume(amt > 0 && amt <= 100 ether);
        vm.startPrank(alice);
        uint256 b = alice.balance;
        al.deposit{value: amt}();
        al.withdraw(amt);
        vm.stopPrank();
        assertEq(alice.balance, b);
        assertEq(address(al).balance, 0);
    }
}

contract Handler is Test {
    Allocator public al;
    bytes32[2] public keys;
    address[3] public actors;
    uint256 public sumFree; // ghost: independent running totals
    uint256 public sumAlloc;
    uint256 public calls;

    constructor(Allocator al_, bytes32 k1, bytes32 k2) {
        al = al_;
        keys = [k1, k2];
        actors = [address(0xA1), address(0xA2), address(0xA3)];
        for (uint256 i; i < 3; ++i) vm.deal(actors[i], 1000 ether);
    }

    function _a(uint256 s) internal view returns (address) {
        return actors[s % 3];
    }

    function deposit(uint256 s, uint96 amt) external {
        address u = _a(s);
        uint256 v = bound(amt, 0, 50 ether);
        vm.prank(u);
        al.deposit{value: v}();
        sumFree += v;
        ++calls;
    }

    function allocate(uint256 s, uint256 k, uint256 amt) external {
        address u = _a(s);
        amt = bound(amt, 0, al.freeBalance(u));
        vm.prank(u);
        al.allocate(keys[k % 2], amt);
        sumFree -= amt;
        sumAlloc += amt;
        ++calls;
    }

    function unallocate(uint256 s, uint256 k, uint256 amt) external {
        address u = _a(s);
        amt = bound(amt, 0, al.allocationOf(u, keys[k % 2]));
        vm.prank(u);
        al.unallocate(keys[k % 2], amt);
        sumFree += amt;
        sumAlloc -= amt;
        ++calls;
    }

    function reallocate(uint256 s, uint256 k, uint256 amt) external {
        address u = _a(s);
        amt = bound(amt, 0, al.allocationOf(u, keys[k % 2]));
        vm.prank(u);
        al.reallocate(keys[k % 2], keys[(k % 2 + 1) % 2], amt);
        ++calls;
    }

    function withdraw(uint256 s, uint256 amt) external {
        address u = _a(s);
        amt = bound(amt, 0, al.freeBalance(u));
        vm.prank(u);
        al.withdraw(amt);
        sumFree -= amt;
        ++calls;
    }
}

contract AllocatorInvariantTest is AllocBase {
    Handler h;

    function setUp() public override {
        super.setUp();
        h = new Handler(al, kConfirmed, kConfirmed2);
        targetContract(address(h));
    }

    /// sum(free) + sum(allocations) == contract balance, with the ghost tracking independent of the contract's own counters.
    function invariant_sumEqualsBalance() public view {
        uint256 free;
        uint256 alloc;
        for (uint256 i; i < 3; ++i) {
            address u = h.actors(i);
            free += al.freeBalance(u);
            alloc += al.userAllocated(u);
            assertEq(al.userAllocated(u), al.allocationOf(u, kConfirmed) + al.allocationOf(u, kConfirmed2));
        }
        assertEq(free + alloc, address(al).balance);
        assertEq(free, h.sumFree());
        assertEq(alloc, h.sumAlloc());
        assertEq(al.totalDeposited(), address(al).balance);
        assertEq(al.agentTotal(kConfirmed) + al.agentTotal(kConfirmed2), alloc);
    }
}
