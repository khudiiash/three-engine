/**
 * Runtime support for user scripts. Scripts import from the bare specifier
 * "engine" (e.g. `import { attribute } from "engine"`), which blob-URL module
 * imports can't resolve — so loaders rewrite it to a blob URL of RUNTIME_SRC
 * via linkEngineImports() before importing.
 *
 * @attribute({ type, default, min?, max?, step?, options? }) on a class field
 * registers it in the class's static `attributes` map; the editor exposes
 * those in the Inspector and ScriptComponent applies saved values on start.
 */
const RUNTIME_SRC = `
export function attribute(options = {}) {
  return function (target, key) {
    const ctor = target.constructor ?? target;
    if (!Object.prototype.hasOwnProperty.call(ctor, "attributes")) {
      ctor.attributes = { ...ctor.attributes };
    }
    ctor.attributes[key] = options;
  };
}
`;

let runtimeUrl = null;

export function getRuntimeUrl() {
  if (!runtimeUrl) {
    runtimeUrl = URL.createObjectURL(new Blob([RUNTIME_SRC], { type: "text/javascript" }));
  }
  return runtimeUrl;
}

/** Rewrites `from "engine"` / `import "engine"` to the runtime blob URL. */
export function linkEngineImports(code) {
  return code.replace(/((?:from|import)\s*)(["'])engine\2/g, (_, lead, q) => `${lead}${q}${getRuntimeUrl()}${q}`);
}
