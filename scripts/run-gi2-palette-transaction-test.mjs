import { createPaletteTransaction } from "../src/modules/gi/window/paletteTransaction.js";

let failures = 0;
const check = (label, condition, detail = "") => {
  console.log(`${condition ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures++;
};

const events = [];
let live = { palette: "old", assignment: "old" };
let held = false;
const txn = createPaletteTransaction({
  publish(payload) {
    events.push(`publish:${payload.palette}`);
    live = payload;
  },
  setHold(on, phase) {
    held = on;
    events.push(`hold:${on ? "on" : "off"}:${phase}`);
  },
});

const token = txn.stage({ palette: "new", assignment: "new" }, { defer: true });
check("topology carry holds before publishing", held && events.join("|") === "hold:on:building");
check("worker wait keeps the old soup's palette and assignment live",
  live.palette === "old" && live.assignment === "old" && txn.phase === "building");
check("a build-phase hold cannot release", txn.release() === false && held);

check("soup install starts the refill transaction", txn.beginRefill(token) && txn.phase === "refilling");
check("refill still keeps the old table live", live.palette === "old" && live.assignment === "old" && held);
check("release publishes before unholding", txn.release()
  && events.slice(-2).join("|") === "publish:new|hold:off:complete");
check("new table and assignment become live atomically",
  live.palette === "new" && live.assignment === "new" && !held && txn.phase === "idle");

const immediate = txn.stage({ palette: "retint", assignment: "old" });
check("plain retint publishes immediately without a hold",
  immediate > token && live.palette === "retint" && !held && events.at(-1) === "publish:retint");

const stale = txn.stage({ palette: "stale", assignment: "stale" }, { defer: true });
const current = txn.stage({ palette: "current", assignment: "current" }, { defer: true });
check("a superseded worker cannot cancel the current hold", !txn.cancel(stale) && held && txn.token === current);
check("current failed worker restores the matched old transport", txn.cancel(current) && !held && live.palette === "retint");

console.log(failures ? `\n${failures} failing` : "\nall ok");
process.exit(failures ? 1 : 0);
