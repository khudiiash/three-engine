/**
 * AI provider settings — an EDITOR preference, not a project setting, for the
 * same reason as `mcpPrefs.js`: which assistant answers a right-click "AI: X"
 * is a fact about the person at the keyboard, not about one project.
 *
 * localStorage, applied the moment it's read (there is nothing to "apply" on
 * change the way MCP has a bridge to reconfigure — a provider reads these
 * values itself at call time, see `providers/ollama.js`), best-effort
 * persistence matching `hierarchyPrefs.js`.
 *
 * `openaiApiKey`, if a user ever fills it in, is stored in plaintext
 * localStorage. The only existing precedent in this codebase is
 * `sketchfab.js`'s token — same tradeoff, same justification: there is no
 * OS keychain integration yet. Defaulting `providerId` to `"ollama"` (local,
 * no key, nothing to leak) means most users never have to make that call at all.
 */
import { create } from "zustand";
import { vmSingleton } from "./singleton.js";

/**
 * What the panel's Model picker offers. Aliases rather than pinned ids, so
 * "opus" keeps meaning the current Opus after a CLI update instead of naming a
 * model that quietly stops existing. `""` defers to the CLI's own setting.
 */
export const CLAUDE_MODELS = [
  { value: "", label: "Default" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

/** `--effort` levels, exactly as the CLI spells them. */
export const CLAUDE_EFFORTS = [
  { value: "", label: "Default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "X-High" },
  { value: "max", label: "Max" },
];

const STORAGE_KEY = "engine.ai.v1";

export const AI_DEFAULTS = Object.freeze({
  // Claude Code CLI, not the local tool loop. A small local model answering
  // a `diagnose` run produced confidently fabricated output (it "described" a
  // screenshot it had never been shown — see the image note in toolLoop.js),
  // and a wrong answer delivered confidently is worse than no answer. The
  // CLI runs on the user's existing subscription and handles the screenshot
  // tool natively over MCP, so it is the honest default. The tool-loop
  // providers stay one dropdown away for anyone who wants local/free, and
  // are still the ONLY providers a `mutates` workflow may run on (they are
  // the ones that can close their own tool set — see providers/index.js).
  providerId: "claude-cli",
  // Empty means "whatever the CLI is configured to use" — the honest default,
  // since the user already picked a model in `claude` itself and silently
  // overriding it from a game editor would be a surprise. The panel's pickers
  // write an explicit alias here when the user wants one for this panel only.
  claudeModel: "",
  claudeEffort: "",
  ollamaBaseUrl: "http://localhost:11434/v1",
  ollamaModel: "qwen3.5:4b",
  openaiBaseUrl: "",
  openaiModel: "",
  openaiApiKey: "",
});

function load() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object") return { ...AI_DEFAULTS };
    return {
      providerId: typeof parsed.providerId === "string" && parsed.providerId ? parsed.providerId : AI_DEFAULTS.providerId,
      claudeModel: typeof parsed.claudeModel === "string" ? parsed.claudeModel : AI_DEFAULTS.claudeModel,
      claudeEffort: typeof parsed.claudeEffort === "string" ? parsed.claudeEffort : AI_DEFAULTS.claudeEffort,
      ollamaBaseUrl: typeof parsed.ollamaBaseUrl === "string" && parsed.ollamaBaseUrl ? parsed.ollamaBaseUrl : AI_DEFAULTS.ollamaBaseUrl,
      ollamaModel: typeof parsed.ollamaModel === "string" && parsed.ollamaModel ? parsed.ollamaModel : AI_DEFAULTS.ollamaModel,
      openaiBaseUrl: typeof parsed.openaiBaseUrl === "string" ? parsed.openaiBaseUrl : AI_DEFAULTS.openaiBaseUrl,
      openaiModel: typeof parsed.openaiModel === "string" ? parsed.openaiModel : AI_DEFAULTS.openaiModel,
      openaiApiKey: typeof parsed.openaiApiKey === "string" ? parsed.openaiApiKey : AI_DEFAULTS.openaiApiKey,
    };
  } catch {
    return { ...AI_DEFAULTS };
  }
}

/** Live AI provider preference. VM-wide so an HMR reload doesn't fork it — see singleton.js. */
export const useAiPrefs = vmSingleton("aiPrefs", () => create(() => load()));

/** Writes a partial update and persists it. Nothing else to apply — see module doc. */
export function setAiPrefs(patch) {
  const next = { ...useAiPrefs.getState(), ...patch };
  useAiPrefs.setState(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Non-fatal: it just won't survive a restart.
  }
  return next;
}
