/**
 * AI workflow registry.
 *
 * This started as a list of narrow, one-click "AI: X" context-menu actions —
 * one of them, "Diagnose this", ever shipped. It was replaced because a fixed
 * prompt is the wrong shape for this feature: the assistant already has the
 * whole editor API and knows what you right-clicked, so the only thing it was
 * missing was *what you actually wanted*, and a canned "tell me what's wrong
 * with this" throws that away. `ask` is the same machinery pointed at a real
 * conversation instead: the context menu supplies the anchor (see
 * `context.js`), you supply the request, and the transcript stays open so you
 * can follow up.
 *
 * `allowedTools` is either an array of op names from `api/registry.js`
 * (dotted, e.g. "entity.get") or the string `"*"` for the whole registry.
 * Either way it is resolved against the LIVE registry by
 * {@link workflowTools}, so a typo fails loudly at run time instead of
 * silently narrowing the model to nothing.
 */
import { opNames, getOp, toJsonSchema } from "../api/registry.js";
import { MCP_SERVER_NAME } from "../mcpClients.js";
import { describeContexts } from "./context.js";

const SYSTEM_PREAMBLE =
  "You are an assistant embedded in the Three Engine editor — a three.js/WebGPU game editor that the user " +
  "has open in front of them right now. Your tools drive that live editor, not files on disk.\n\n" +
  "How to work here:\n" +
  "- Look before you answer. Never describe an entity, component, asset or setting you have not read with a tool.\n" +
  "- component.types lists every component and its real property names. Read it rather than guessing at a name.\n" +
  "- Scene edits (entity.*, component.*) go through the editor's undo stack, so the user can take them back. " +
  "Prefer them to writing files by hand, and never hand-edit a .scene file.\n" +
  "- asset.delete, asset.write and the build tools are NOT undoable. Ask before deleting the user's files.\n" +
  "- If a tool refuses because an engine module is disabled, say which module — do not work around it by " +
  "editing files.\n" +
  "- Answer in plain prose, briefly. The user is looking at the editor, not at a report.";

export const WORKFLOWS = [
  {
    id: "ask",
    label: "Ask AI",
    // The user typed this request and is watching the transcript stream, which
    // is what makes the full tool set the right call rather than a reckless
    // one: it is the same trust posture as the Terminal panel, which already
    // ships a fully-permissioned `claude` session. `interactive` is what
    // aiStore.js checks before applying the unattended-mutating-run rule — see
    // the comment on that guard.
    interactive: true,
    mutates: true,
    allowedTools: "*",
    systemPrompt: SYSTEM_PREAMBLE,
    /**
     * One turn's prompt.
     *
     * The context paragraph rides along with EVERY message that has chips
     * attached, not just the first. That is a change from the one-shot
     * version, and it is deliberate: chips are now per-message (you drag a
     * second entity in on turn four), so "the assistant already has it in its
     * history" stops being true the moment the anchor can change mid
     * conversation. Repeating unchanged chips costs a few dozen tokens and
     * removes any chance of the model answering about turn one's entity when
     * you are asking about turn four's.
     */
    buildPrompt: ({ text, contexts }) => {
      const preamble = describeContexts(contexts);
      return preamble ? `${preamble}\n\n${text}` : text;
    },
  },
];

export function getWorkflow(id) {
  return WORKFLOWS.find((w) => w.id === id) ?? null;
}

/**
 * A workflow's `allowedTools` resolved against the live registry to a concrete
 * array of op names.
 *
 * `"*"` means the whole registry — the honest way to say "this is a general
 * assistant" without pinning a 190-entry list in this file that goes stale the
 * moment someone adds an op. An explicit array is still checked name by name,
 * so a typo throws here rather than silently handing the model a shorter list
 * than its author intended.
 */
export function workflowTools(workflow) {
  const known = opNames();
  if (workflow.allowedTools === "*") return known;
  const set = new Set(known);
  const missing = workflow.allowedTools.filter((name) => !set.has(name));
  if (missing.length) {
    throw new Error(`Workflow "${workflow.id}" references unknown op(s): ${missing.join(", ")}`);
  }
  return [...workflow.allowedTools];
}

/** True when this workflow may call an op that changes the project. */
export function workflowIsReadOnly(workflow) {
  return workflowTools(workflow).every((name) => getOp(name)?.readOnly);
}

/**
 * A workflow's tools, resolved to the exact strings the `claude` CLI's
 * `--allowedTools` flag expects for MCP tools: `mcp__<server>__<tool>`, with
 * dots turned into underscores the same way {@link toolManifest} in
 * `api/registry.js` names them.
 */
export function resolveAllowedTools(workflow) {
  return workflowTools(workflow).map((name) => `mcp__${MCP_SERVER_NAME}__${name.replaceAll(".", "_")}`);
}

/**
 * A workflow's tools, resolved to OpenAI `chat/completions`-shaped tool
 * descriptors — what `toolLoop.js` hands the request as `tools:[...]`.
 * Reuses `toJsonSchema` from `api/registry.js` rather than re-deriving a
 * schema converter; dots are stripped from tool names the same way
 * `resolveAllowedTools`/`toolManifest` do it, since neither an MCP tool name
 * nor an OpenAI function name may contain one.
 */
export function resolveToolSchemas(workflow) {
  return workflowTools(workflow).map((name) => {
    const op = getOp(name);
    return {
      type: "function",
      function: {
        name: name.replaceAll(".", "_"),
        description: op.description,
        parameters: toJsonSchema(op.params),
      },
    };
  });
}
