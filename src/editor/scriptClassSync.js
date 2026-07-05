/**
 * Helpers for keeping a script's default-exported class name in sync with its
 * filename. Used by both the Assets panel's inline rename and the Asset
 * Inspector's name field, so the two rename flows behave identically.
 */

/** File stem → PascalCase identifier (e.g. "player_controller" → "PlayerController").
 *  Guarantees the result is a valid JS class name (starts with a letter/_, no
 *  leading digits). Falls back to "NewScript" for purely-symbolic input. */
export function stemToClassName(stem) {
  const parts = stem
    .replace(/\.(ts|js)$/i, "")
    .split(/[\s\-_]+/)
    .filter(Boolean);
  const pascal = parts
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("")
    // Drop anything outside the JS identifier character set (TS/JS identifiers
    // can contain letters, digits, _, $ — but the first char must not be a
    // digit, handled by prepending "Script" if necessary below).
    .replace(/[^A-Za-z0-9_$]/g, "");
  if (!pascal) return "NewScript";
  if (/^[0-9]/.test(pascal)) return `Script${pascal}`;
  return pascal;
}

/**
 * Rewrites a `.ts`/`.js` script so its default-exported class matches the new
 * filename's stem, and (if missing) extends the engine `Script` base class.
 *
 * - `export default class Foo extends Script` → `export default class NewFoo extends Script`
 * - `export default class Foo { ... }`        → `export default class NewFoo extends Script { ... }`
 *
 * Returns the modified source, or `null` if the file isn't a script / has no
 * recognizable default-exported class (in which case the rename still happens
 * but the class name is left as-is).
 */
export async function syncScriptClassName(filePath, newStem) {
  const ext = filePath.toLowerCase();
  const lower = filePath.toLowerCase();
  if (!lower.endsWith(".ts") && !lower.endsWith(".js")) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  let raw;
  try {
    raw = await invoke("read_text_file", { path: filePath });
  } catch {
    return null;
  }
  // Find the start of `export default class <Name>` (no further parsing yet).
  const classDeclRe = /\bexport\s+default\s+class\s+[A-Za-z_$][\w$]*/g;
  const match = classDeclRe.exec(raw);
  if (!match) return null;

  // Walk forward from end-of-name, tracking nested angle brackets and parens,
  // until we hit the class body open `{` at depth 0. That walks over any
  // generic parameter list (`<T, U>`), the optional `extends <TypeRef>`
  // clause (where TypeRef may itself have generics, e.g. `Base<Props>`), and
  // any implements clause.
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
  if (i >= raw.length) return null; // no class body found
  const middle = raw.slice(middleStart, i);
  const body = raw.slice(i);

  // If the script has no `extends` clause, inject `extends Script` so the
  // engine's typed context (`this.entity`, `this.engine`, …) is picked up.
  let newMiddle = middle;
  if (!/\bextends\b/.test(middle)) {
    newMiddle = middle.replace(/(\s*)$/, "") + " extends Script" + (middle.match(/(\s*)$/)?.[1] ?? "");
    if (!/\s$/.test(newMiddle)) newMiddle += " ";
  }

  const newClassName = stemToClassName(newStem);
  const declOpen = `export default class ${newClassName}`;
  return raw.slice(0, match.index) + declOpen + newMiddle + body;
}

/**
 * After a rename on disk, rewrites the script's class name (and injects
 * `extends Script` if missing). Caller is responsible for the actual
 * `rename_path` invocation; this only handles the in-file class-name sync.
 *
 * Safe to call on non-script files — returns null and does nothing.
 */
export async function syncScriptClassNameAfterRename(newPath, newStem) {
  const lower = newPath.toLowerCase();
  if (!lower.endsWith(".ts") && !lower.endsWith(".js")) return;
  const { invoke } = await import("@tauri-apps/api/core");
  const updated = await syncScriptClassName(newPath, newStem);
  if (updated !== null) {
    try {
      await invoke("save_scene", { path: newPath, contents: updated });
    } catch (err) {
      console.warn(`Renamed file but couldn't sync class name: ${err}`);
    }
  }
}