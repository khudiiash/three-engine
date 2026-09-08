/**
 * The "Ask AI" gesture, in one place.
 *
 * Every context menu that offers it does the same three things — point the
 * conversation at what was right-clicked, bring the panel up, and let the user
 * type — so they call {@link askAiMenuItem} rather than each spelling it out.
 * The old "AI: Diagnose this" items had already drifted apart between the
 * hierarchy and the viewport (a duplicated provider-capability check, worded
 * slightly differently in each); a shared factory is what stops that happening
 * again as more menus grow one.
 *
 * The panel import is dynamic for the same reason `assetActions.js` and
 * `codeStore.js` do it: `EditorShell.jsx` imports essentially every panel,
 * so a static import here would drag the whole editor into any module that
 * merely wants to offer the menu item.
 */
import { Sparkles } from "../icons/index.jsx";
import { setAiContexts } from "../store/aiStore.js";
import { entityContext, assetContext, sceneContext, projectContext } from "./context.js";
import { engine } from "../engineInstance.js";

/** Points the AI panel at `context` and brings it forward. */
export function askAi(context = null) {
  setAiContexts(context ? [context] : []);
  return import("../EditorShell.jsx").then((m) => m.openPanel("ai"));
}

/** A context menu entry, ready to spread into an `items` array. */
export function askAiMenuItem(context, { disabled = false, hint } = {}) {
  return {
    label: "Ask AI",
    icon: Sparkles,
    disabled,
    hint,
    action: () => askAi(context),
  };
}

/**
 * The context for a set of selected entity ids, labelled by NAME rather than
 * id — an id is the right thing to hand the model and the wrong thing to show
 * a person, who named the entity "Player" precisely so they would not have to
 * read `e_3f9a`.
 */
export function entitySelectionContext(ids) {
  const list = Array.isArray(ids) ? ids : [ids];
  const label =
    list.length === 1 ? (engine.getEntity(list[0])?.name ?? list[0]) : `${list.length} entities`;
  return entityContext(list, label);
}

/** The context for a set of selected asset paths. */
export function assetSelectionContext(paths) {
  return assetContext(Array.isArray(paths) ? paths : [paths]);
}

export { sceneContext, projectContext };
