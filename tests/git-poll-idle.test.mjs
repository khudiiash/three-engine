/**
 * ⛔⛔ AN IDLE EDITOR MUST NOT FREEZE ON A TIMER.
 *
 * Measured on Sponza, 2026-09-08: two main-thread blocks of ~250 ms, exactly
 * 8 000 ms apart, in an editor nobody was touching — about half a second of
 * every eight, forever. `POLL_VISIBLE` in `gitStore.js` is 8 000 ms.
 *
 * ⛔ AND IT IS NOT GIT THAT IS SLOW. The freeze ledger charges the four git
 * commands **0.4 ms** together (`git:read`), and `git status` on the project
 * takes 38 ms at the shell for 250 entries. The cost is the RE-RENDER each
 * `setState` provokes: both readers subscribe to the whole store
 * (`useGitStore()` with no selector, in MenuBar and GitPanel), so any write
 * re-renders the entire menu bar — and the poll wrote twice, unconditionally,
 * whether or not one byte of the repository had changed.
 *
 * These tests hold the two claims the fix rests on.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { create } from "zustand";

import { gitStateUnchanged } from "../src/editor/git/gitStateDiff.js";

/** What one poll produces. Fresh objects every time, exactly as `readStatus` returns them. */
const poll = (overrides = {}) => ({
  branch: "main",
  files: [
    { path: "src/a.js", status: "M", staged: false },
    { path: "src/b.js", status: "??", untracked: true },
  ],
  branches: ["main", "feature/x"],
  remotes: [{ name: "origin", url: "git@example.com:me/repo.git" }],
  identity: { name: "khudiiash", email: "someone@example.com" },
  operation: null,
  loading: false,
  error: null,
  refreshedAt: Date.now(),
  ...overrides,
});

test("⭐⭐ THE BUG: a poll that found nothing is not a change, though every object is new", () => {
  // This is the whole defect. `readStatus` builds a NEW array of NEW objects
  // each time, so `current.files === next.files` is false on every poll even
  // when the repository has not been touched — and an identity comparison
  // therefore re-rendered the menu bar every 8 seconds for nothing.
  const current = poll({ refreshedAt: 1000 });
  const next = poll({ refreshedAt: 9000 });

  assert.notEqual(current.files, next.files, "the fixture must use fresh objects, or it proves nothing");
  assert.equal(gitStateUnchanged(current, next), true);
});

test("⛔ refreshedAt alone is never a change — and that is deliberate", () => {
  // It moves every poll by construction. Counting it would make every poll
  // "changed" and leave the freeze exactly where it was. It is also a
  // `useEffect` dependency of DiffPane and HistoryPane, so advancing it
  // re-runs `git diff` and `git log` — work with no new answer to find.
  assert.equal(gitStateUnchanged(poll({ refreshedAt: 1 }), poll({ refreshedAt: 2 })), true);
});

test("⭐ a real change is still seen — every field the panel reads", () => {
  const base = poll({ refreshedAt: 1 });
  const changes = {
    "a file's status": { files: [{ path: "src/a.js", status: "A", staged: true }] },
    "a new file": { files: [...base.files, { path: "src/c.js", status: "??" }] },
    "a removed file": { files: [base.files[0]] },
    "the branch": { branch: "release" },
    "the branch list": { branches: ["main"] },
    "a remote": { remotes: [{ name: "origin", url: "https://example.com/other.git" }] },
    "the identity": { identity: { name: "someone else", email: "other@example.com" } },
    "a rebase starting": { operation: "REBASE" },
    "an error": { error: "fatal: not a git repository" },
  };
  for (const [what, override] of Object.entries(changes)) {
    assert.equal(gitStateUnchanged(base, poll({ refreshedAt: 2, ...override })), false,
      `${what} must count as a change`);
  }
});

test("a first poll against an empty store is a change", () => {
  assert.equal(gitStateUnchanged({}, poll()), false);
  assert.equal(gitStateUnchanged(undefined, poll()), false);
});

test("⛔⛔ THE ZUSTAND BEHAVIOUR THE FIX DEPENDS ON: an empty write still notifies", () => {
  // `commit` must return WITHOUT CALLING setState when nothing changed. The
  // tempting shorter version — always write, but write `{}` — does not work,
  // and this is why: zustand notifies whenever the partial is not the state
  // object itself, so `setState({})` re-renders every subscriber and leaves
  // the 250 ms block exactly where it was.
  const store = create(() => ({ files: [], loading: false }));
  let notified = 0;
  store.subscribe(() => { notified++; });

  store.setState({});
  assert.equal(notified, 1, "an empty partial DOES notify — so the fix must skip the call entirely");

  // And the shape the fix actually uses: no call at all.
  const before = notified;
  const next = poll();
  if (!gitStateUnchanged(store.getState(), next)) store.setState(next);
  assert.equal(notified, before + 1, "a genuine change writes once");

  const after = notified;
  if (!gitStateUnchanged(store.getState(), poll({ refreshedAt: Date.now() + 5000 }))) {
    store.setState(poll());
  }
  assert.equal(notified, after, "⭐ the next idle poll must not notify anyone at all");
});
