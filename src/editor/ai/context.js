/**
 * What an "Ask AI" conversation is anchored to.
 *
 * The whole point of the panel is that you don't have to describe what you're
 * looking at: you right-click the thing, or drag it onto the panel, and the
 * assistant already knows which entity, which asset, which scene you meant.
 * That anchor is this module's only job — small, serializable
 * `{kind, refs, label}` values that the panel renders as chips and
 * `describeContexts` turns into the paragraph the model reads.
 *
 * A conversation holds a LIST of these, not one, because that is how the
 * question is actually shaped: "why does this material look wrong on that
 * mesh" is two chips, and dragging a second entity in should add to the
 * question rather than replace it.
 *
 * Deliberately NOT a snapshot of the things themselves. Dumping an entity's
 * full component tree into the prompt would be stale by the second turn and
 * huge by the fifth; naming the ids and telling the model which tool reads
 * them costs a few dozen tokens and is always current. The editor's own op
 * registry is the source of truth — see `workflows.js`.
 */

/** Singular/plural noun for each kind, used in chip labels. */
const KIND_NOUN = {
  entity: ["entity", "entities"],
  asset: ["asset", "assets"],
  scene: ["scene", "scenes"],
  project: ["project", "projects"],
  file: ["file", "files"],
  viewport: ["viewport", "viewports"],
};

/**
 * `{kind, refs, label}`. `refs` is always an array of strings — entity ids,
 * asset paths, absolute file paths, or `[]` for the kinds that reference
 * something singular by nature (scene, project, viewport), so callers never
 * have to branch on "one or many".
 */
export function makeAiContext(kind, refs = [], label = null) {
  const list = (Array.isArray(refs) ? refs : [refs]).filter((r) => typeof r === "string" && r);
  return { kind, refs: list, label: label ?? defaultLabel(kind, list) };
}

export const entityContext = (ids, label) => makeAiContext("entity", ids, label);
export const assetContext = (paths, label) => makeAiContext("asset", paths, label);
export const fileContext = (paths, label) => makeAiContext("file", paths, label);
export const sceneContext = (name) => makeAiContext("scene", [], name ?? "Scene");
export const projectContext = (name) => makeAiContext("project", [], name ?? "Project");
export const viewportContext = () => makeAiContext("viewport", [], "Viewport");

function defaultLabel(kind, refs) {
  const [one, many] = KIND_NOUN[kind] ?? [kind, `${kind}s`];
  if (!refs.length) return one[0].toUpperCase() + one.slice(1);
  if (refs.length === 1) return kind === "asset" || kind === "file" ? basename(refs[0]) : refs[0];
  return `${refs.length} ${many}`;
}

function basename(path) {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

/** Stable identity for a chip, so adding the same thing twice is a no-op. */
export function contextKey(context) {
  return `${context.kind}:${context.refs.join("|")}`;
}

/**
 * Merges `next` into `list`, replacing any chip with the same key and keeping
 * insertion order otherwise. Dropping the same entity twice should not grow
 * the chip row.
 */
export function addContext(list, next) {
  const key = contextKey(next);
  const without = list.filter((c) => contextKey(c) !== key);
  return [...without, next];
}

/** One chip's paragraph. */
function describeOne(context) {
  const { kind, refs } = context;
  const many = refs.length !== 1;

  if (kind === "entity" && refs.length) {
    return (
      `Entity id${many ? "s" : ""} the user pointed at: ${refs.join(", ")}. ` +
      "Call entity.get (and component.types if you need real property names) on those before answering — " +
      "do not guess at their components or transforms."
    );
  }
  if (kind === "asset" && refs.length) {
    return (
      `Project asset path${many ? "s" : ""} the user pointed at: ${refs.join(", ")}. ` +
      "Use asset.read for text assets and asset.list for what sits beside them."
    );
  }
  if (kind === "file" && refs.length) {
    // Attached from the file dialog, so these are absolute paths anywhere on
    // disk — the CLI's own Read tool handles them, including images.
    return `File${many ? "s" : ""} the user attached: ${refs.join(", ")}. Read ${many ? "them" : "it"} before answering.`;
  }
  if (kind === "viewport") {
    // No bytes are captured here on purpose. The claudeCli provider passes
    // MCP image results to the model natively, so asking it to take the
    // screenshot itself is both simpler than staging a temp file and gets a
    // picture of the viewport as it is when the question is answered rather
    // than as it was when the chip was added.
    return "The user wants you to look at the viewport: call viewport.screenshot and examine the image before answering.";
  }
  if (kind === "scene") {
    return "The user is asking about the currently open scene as a whole. Start with scene.get and entity.list rather than assuming what it contains.";
  }
  if (kind === "project") {
    return "The user is asking about the project as a whole. Start with project.get, module.list and scene.get rather than assuming what it contains.";
  }
  return "";
}

/**
 * The context paragraph prepended to a message.
 *
 * Returns "" for an empty list, which is a real state: the panel opens from
 * the menu bar with nothing selected, and "why is my frame rate low" needs no
 * anchor at all.
 */
export function describeContexts(contexts) {
  const parts = (contexts ?? []).map(describeOne).filter(Boolean);
  if (!parts.length) return "";
  return `Context the user attached to this message:\n${parts.map((p) => `- ${p}`).join("\n")}`;
}
