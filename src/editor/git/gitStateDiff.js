// @ts-check
/**
 * DID THIS POLL FIND ANYTHING?
 *
 * ⛔⛔ **A POLL THAT FINDS NOTHING MUST WRITE NOTHING.**
 *
 * Measured on Sponza, 2026-09-08: two main-thread blocks of ~250 ms, exactly
 * 8 000 ms apart, in a completely idle editor — about half a second of every
 * eight, forever. That is `gitStore`'s poll (`POLL_VISIBLE` is 8 000 ms), and
 * NOT because git is slow: the freeze ledger charges the four git commands
 * **0.4 ms** together, and `git status` on the project takes 38 ms at the shell
 * for 250 entries.
 *
 * The cost is the RE-RENDER each `setState` provokes. Two writes per poll —
 * `{loading:true}` on the way in, the result on the way out — are two renders
 * about 470 ms apart, which is exactly the pair in the ledger. And they are
 * expensive because both readers subscribe to the WHOLE store (`useGitStore()`
 * with no selector, in `MenuBar` and `GitPanel`), so every write re-renders the
 * entire menu bar whether or not a single byte differed.
 *
 * ⚠ THE RENDER IS NOT INSIDE THE `setState` CALL, which is why marking the
 * write with a freeze span found nothing. React schedules it, so it lands in a
 * LATER task and is charged to `(unattributed)`. Do not go looking for it with
 * another span — the way to confirm this fix is that the blocks stop.
 *
 * Lives in its own module with NO imports so it can be tested directly:
 * `gitStore.js` reaches the project store and, through it, a `.d.ts` that node
 * cannot load in a bare test.
 */

/**
 * Whether `next` says the same thing as `current` about the repository.
 *
 * @param {Record<string, any> | null | undefined} current
 * @param {Record<string, any>} next
 */
export function gitStateUnchanged(current, next) {
  for (const key of Object.keys(next)) {
    // ⛔ `refreshedAt` IS EXCLUDED, AND IT IS THE MOST IMPORTANT EXCLUSION.
    // It moves every poll by construction, so comparing it would make every
    // poll "changed" and defeat the check entirely. It is also not cosmetic:
    // `GitPanel`'s DiffPane and HistoryPane take it as a `useEffect`
    // DEPENDENCY, so advancing it re-runs `git diff` AND `git log` in the open
    // panel. Holding it still while the repository is unchanged is therefore
    // not a shortcut but the correct answer — there is no new diff to fetch.
    if (key === "refreshedAt") continue;
    const a = current?.[key], b = next[key];
    if (a === b) continue;
    // ⚠ AND AN IDENTITY TEST ALONE WOULD FIND NOTHING. `readStatus` builds a
    // new array of new objects every poll, so `a === b` is false for `files`
    // on every single poll even when the repository has not been touched —
    // which is precisely how this went unnoticed. These are small JSON-shaped
    // records; serialising 250 entries costs a fraction of a millisecond
    // against the ~250 ms render it prevents.
    try {
      if (JSON.stringify(a) !== JSON.stringify(b)) return false;
    } catch { return false; }
  }
  return true;
}
