import test from "node:test";
import assert from "node:assert/strict";
import { ALLIANCE_DURATION_TICKS, AllianceRegistry, NO_ALLIANCES } from "../src/Core/alliances.js";

test("a proposal stays pending until the recipient accepts", () => {
  const reg = new AllianceRegistry();
  assert.equal(reg.propose(1, 2), "proposed");
  assert.equal(reg.areAllied(1, 2), false, "an unanswered offer is not yet an alliance");
  assert.deepEqual(reg.incomingProposals(2), [1]);
  assert.deepEqual(reg.outgoingProposals(1), [2]);

  assert.equal(reg.accept(2, 1), true);
  assert.equal(reg.areAllied(1, 2), true);
  assert.equal(reg.areAllied(2, 1), true, "alliances are symmetric");
  assert.deepEqual(reg.incomingProposals(2), [], "the proposal is cleared once accepted");
  assert.deepEqual(reg.alliesOf(1), [2]);
});

test("crossing offers meet in the middle and form the alliance at once", () => {
  const reg = new AllianceRegistry();
  assert.equal(reg.propose(2, 1), "proposed");
  // 1 proposing back to 2, who already offered, seals the pact immediately.
  assert.equal(reg.propose(1, 2), "accepted");
  assert.equal(reg.areAllied(1, 2), true);
  assert.deepEqual(reg.proposals(), [], "no proposals linger after an auto-accept");
});

test("duplicate and self/neutral proposals are rejected without effect", () => {
  const reg = new AllianceRegistry();
  assert.equal(reg.propose(1, 1), "invalid", "no self-alliance");
  assert.equal(reg.propose(1, 0), "invalid", "no alliance with neutral");
  assert.equal(reg.propose(1, 2), "proposed");
  assert.equal(reg.propose(1, 2), "already-proposed", "a second identical offer is a no-op");
  reg.accept(2, 1);
  assert.equal(reg.propose(1, 2), "already-allied", "can't re-propose to a current ally");
});

test("decline clears the offer without forming an alliance", () => {
  const reg = new AllianceRegistry();
  reg.propose(1, 2);
  assert.equal(reg.decline(2, 1), true);
  assert.equal(reg.areAllied(1, 2), false);
  assert.deepEqual(reg.incomingProposals(2), []);
  assert.equal(reg.accept(2, 1), false, "nothing left to accept after a decline");
});

test("breaking an alliance dissolves it on both sides", () => {
  const reg = new AllianceRegistry();
  reg.propose(1, 2);
  reg.accept(2, 1);
  assert.equal(reg.breakAlliance(1, 2), true);
  assert.equal(reg.areAllied(1, 2), false);
  assert.equal(reg.areAllied(2, 1), false);
  assert.equal(reg.breakAlliance(1, 2), false, "breaking a non-existent pact is a no-op");
});

test("removePlayer scrubs every pact and proposal touching the player", () => {
  const reg = new AllianceRegistry();
  reg.propose(1, 2);
  reg.accept(2, 1); // 1 & 2 allied
  reg.propose(3, 2); // 3 has a pending offer to 2
  reg.propose(2, 4); // 2 has a pending offer to 4

  reg.removePlayer(2);
  assert.equal(reg.areAllied(1, 2), false, "the alliance is gone");
  assert.deepEqual(reg.alliesOf(1), [], "the surviving partner keeps no dangling ally");
  assert.deepEqual(reg.incomingProposals(4), [], "the removed player's outgoing offers vanish");
  assert.deepEqual(reg.outgoingProposals(3), [], "offers addressed to the removed player vanish");
});

test("pairs and proposals are canonical and deterministically ordered", () => {
  const reg = new AllianceRegistry();
  reg.propose(3, 1);
  reg.accept(1, 3); // pair (1,3)
  reg.propose(2, 1);
  reg.accept(1, 2); // pair (1,2)
  reg.propose(4, 2); // pending 4 -> 2

  assert.deepEqual(reg.pairs(), [[1, 2], [1, 3]], "pairs are [low,high], ascending, dedup'd");
  assert.deepEqual(reg.proposals(), [{ from: 4, to: 2 }]);
});

test("NO_ALLIANCES treats everyone as unallied", () => {
  assert.equal(NO_ALLIANCES.areAllied(1, 2), false);
  assert.equal(NO_ALLIANCES.areAllied(5, 5), false);
});

// ---- Lifecycle: expiry, renewal and the betrayal ledger ---------------------

test("a pact lapses after ALLIANCE_DURATION_TICKS with no betrayal recorded", () => {
  const reg = new AllianceRegistry();
  reg.propose(1, 2, 100);
  reg.accept(2, 1, 100);
  assert.equal(reg.ticksLeft(1, 2, 100), ALLIANCE_DURATION_TICKS);

  assert.deepEqual(reg.expireDue(100 + ALLIANCE_DURATION_TICKS - 1), [], "still alive one tick early");
  assert.equal(reg.areAllied(1, 2), true);

  assert.deepEqual(reg.expireDue(100 + ALLIANCE_DURATION_TICKS), [[1, 2]], "lapses exactly on time");
  assert.equal(reg.areAllied(1, 2), false);
  assert.equal(reg.betrayalsOf(1), 0, "natural expiry is not a betrayal");
  assert.equal(reg.betrayalsOf(2), 0);
  assert.equal(reg.ticksLeft(1, 2, 100 + ALLIANCE_DURATION_TICKS), null, "no pact left to time");
});

test("renewal needs both votes and restarts the clock", () => {
  const reg = new AllianceRegistry();
  reg.propose(1, 2, 0);
  reg.accept(2, 1, 0);

  assert.equal(reg.voteRenew(1, 2, 2800), "voted", "the first vote parks");
  assert.equal(reg.hasRenewVote(1, 2), true);
  assert.equal(reg.voteRenew(1, 2, 2800), "already-voted", "no double vote");
  assert.equal(reg.ticksLeft(1, 2, 2800), ALLIANCE_DURATION_TICKS - 2800, "one vote extends nothing");

  assert.equal(reg.voteRenew(2, 1, 2900), "renewed", "the second vote seals it");
  assert.equal(reg.ticksLeft(1, 2, 2900), ALLIANCE_DURATION_TICKS, "the clock restarted");
  assert.equal(reg.hasRenewVote(1, 2), false, "votes clear after a renewal");
  assert.deepEqual(reg.expireDue(3000), [], "the renewed pact survives its old deadline");

  assert.equal(reg.voteRenew(3, 1, 0), "invalid", "no renewal without a pact");
});

test("explicit breaks are tallied against the breaker only", () => {
  const reg = new AllianceRegistry();
  reg.propose(1, 2, 0);
  reg.accept(2, 1, 0);
  reg.propose(1, 3, 0);
  reg.accept(3, 1, 0);

  assert.equal(reg.breakAlliance(1, 2), true);
  assert.equal(reg.breakAlliance(1, 3), true);
  assert.equal(reg.breakAlliance(1, 3), false, "no pact left to break");
  assert.equal(reg.betrayalsOf(1), 2, "the breaker's ledger counts both betrayals");
  assert.equal(reg.betrayalsOf(2), 0, "the betrayed side stays clean");
  assert.equal(reg.betrayalsOf(3), 0);
});
