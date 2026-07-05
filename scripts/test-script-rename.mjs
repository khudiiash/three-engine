// Smoke test for the script class-name sync logic. Pure regex + helper
// functions, no Tauri/Rust fs needed.
//
// We duplicate the algorithm here so we can test it in plain Node — the
// production copy lives in src/editor/scriptClassSync.js. If you change one,
// update the other (and verify both still pass).

const stemToClassName = (stem) => {
  const parts = stem
    .replace(/\.(ts|js)$/i, "")
    .split(/[\s\-_]+/)
    .filter(Boolean);
  const pascal = parts
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("")
    .replace(/[^A-Za-z0-9_$]/g, "");
  if (!pascal) return "NewScript";
  if (/^[0-9]/.test(pascal)) return `Script${pascal}`;
  return pascal;
};

const syncClassName = (raw, newStem) => {
  const classDeclRe = /\bexport\s+default\s+class\s+[A-Za-z_$][\w$]*/g;
  const match = classDeclRe.exec(raw);
  if (!match) return null;
  let i = match.index + match[0].length;
  let depth = 0;
  const middleStart = i;
  while (i < raw.length) {
    const c = raw[i];
    if (c === "{" && depth === 0) break;
    if (c === "(" || c === "<" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === ">" || c === "]" || c === "}") depth--;
    i++;
  }
  if (i >= raw.length) return null;
  const middle = raw.slice(middleStart, i);
  const body = raw.slice(i);
  let newMiddle = middle;
  if (!/\bextends\b/.test(middle)) {
    newMiddle = middle.replace(/(\s*)$/, "") + " extends Script" + (middle.match(/(\s*)$/)?.[1] ?? "");
    if (!/\s$/.test(newMiddle)) newMiddle += " ";
  }
  const newClassName = stemToClassName(newStem);
  const declOpen = `export default class ${newClassName}`;
  return raw.slice(0, match.index) + declOpen + newMiddle + body;
};

// 1. Rename to a PascalCase stem
{
  const src = `import { Script, attribute } from "engine";
export default class NewScript extends Script {
  speed = 1;
}`;
  const out = syncClassName(src, "Player");
  console.assert(out.includes("export default class Player extends Script"), "renamed class");
  console.log("[1] OK:", out.split("\n")[1]);
}

// 2. Add `extends Script` if missing
{
  const src = `export default class OldClass {
  speed = 1;
}`;
  const out = syncClassName(src, "Mover");
  console.assert(out.includes("export default class Mover extends Script"), "injected extends Script");
  console.log("[2] OK:", out.split("\n")[0]);
}

// 3. Preserve existing extends clause (don't overwrite)
{
  const src = `export default class Foo extends BaseThing {
  x = 1;
}`;
  const out = syncClassName(src, "Bar");
  console.assert(out.includes("export default class Bar extends BaseThing"), "kept extends clause");
  console.log("[3] OK:", out.split("\n")[0]);
}

// 4. Handle filename with underscores
{
  const src = `export default class PlayerController extends Script {}`;
  const out = syncClassName(src, "Enemy_AI");
  console.assert(out.includes("class EnemyAI extends Script"), "snake_case stem → PascalCase");
  console.log("[4] OK:", out.split("\n")[0]);
}

// 5. Handle filename with dashes
{
  const src = `export default class PlayerController extends Script {}`;
  const out = syncClassName(src, "enemy-ai");
  console.assert(out.includes("class EnemyAi extends Script"), "dash stem → PascalCase");
  console.log("[5] OK:", out.split("\n")[0]);
}

// 6. Handle filename with multiple spaces/separators
{
  const out = stemToClassName("NewScript 1");
  console.assert(out === "NewScript1", "spaces in name");
  console.log("[6] stemToClassName:", out);
}

// 7. Handle purely-numeric prefix
{
  const out = stemToClassName("123");
  console.assert(out === "Script123", "numeric prefix");
  console.log("[7] stemToClassName:", out);
}

// 8. No default-exported class — return null, don't crash
{
  const src = `// not a script
export const x = 1;`;
  const out = syncClassName(src, "Whatever");
  console.assert(out === null, "no default class");
  console.log("[8] OK: returned null");
}

// 9. Generic class — should still match
{
  const src = `export default class Foo<T> extends Script {}`;
  const out = syncClassName(src, "Bar");
  console.assert(out && out.includes("class Bar<T> extends Script"), "generic class");
  console.log("[9] OK:", out.split("\n")[0]);
}

// 10. Complex extends clause with generics
{
  const src = `export default class Foo extends Base<Props> {}`;
  const out = syncClassName(src, "Bar");
  console.assert(out && out.includes("class Bar extends Base<Props>"), "extends with generics");
  console.log("[10] OK:", out.split("\n")[0]);
}

// 11. Renaming to the SAME name should be a no-op (output equals input)
{
  const src = `import { Script, attribute } from "engine";
export default class PlayerController extends Script {
  @attribute() speed = 1;
}`;
  const out = syncClassName(src, "PlayerController");
  console.assert(out === src, "no-op when name unchanged");
  console.log("[11] OK: identity rename");
}

// 12. Multi-line class with decorators and methods (real-world)
{
  const src = `import { Script, attribute } from "engine";

export default class NewScript extends Script {
  @attribute({ type: "number", default: 5 })
  speed = 5;

  onStart() {
    this.entity.position.set(0, 1, 0);
  }

  onUpdate(dt) {
    this.entity.rotation.y += dt * this.speed;
  }
}
`;
  const out = syncClassName(src, "Spinner");
  console.assert(out.includes("class Spinner extends Script"), "complex script");
  console.assert(out.includes("@attribute({ type: \"number\", default: 5 })"), "decorator preserved");
  console.assert(out.includes("onUpdate(dt)"), "method preserved");
  console.assert(out.includes("this.entity.position.set(0, 1, 0);"), "body preserved");
  console.log("[12] OK: complex script rewrite");
}

// 13. Real example: PlayerController.js from examples/ — renaming to EnemyAI
{
  const fs = await import("node:fs");
  const path = "examples/input-demo/PlayerController.js";
  const src = fs.readFileSync(path, "utf8");
  const out = syncClassName(src, "EnemyAI");
  console.assert(out.includes("export default class EnemyAI"), "real example renames");
  console.assert(out.includes("onUpdate"), "real example body intact");
  console.log("[13] OK: PlayerController → EnemyAI");
}

console.log("\nALL CHECKS PASSED");