/**
 * Headless Claude Code CLI provider.
 *
 * Runs one headless `claude -p` turn per message sent from the AI panel —
 * as opposed to TerminalPanel.jsx's long-lived interactive PTY session. The
 * turns are stitched into a conversation by `--resume` (see `runTurn`), so
 * "headless" describes how the process is driven, not how much it remembers.
 * It reuses the exact same MCP server this editor already ships
 * (`mcp/server.mjs`, the one the interactive terminal registers via the
 * Connect buttons in McpPanel.jsx), scoped for this one run alone:
 *
 *   - `--mcp-config` + `--strict-mcp-config` so the model can reach ONLY this
 *     editor's tools, not whatever else is in the user's global Claude config;
 *   - `--allowedTools` names WHICH of the editor's MCP tools this run may use.
 *     The `ask` workflow declares `"*"` (the whole registry) because it is a
 *     general assistant the user is talking to; a future narrow workflow can
 *     still declare a subset, and workflows.js resolves either the same way.
 *   - `--permission-mode bypassPermissions` because this is headless: nothing
 *     can answer an interactive tool-approval prompt.
 *
 * This provider's tool set is **not scopeable** in the way the tool-loop
 * providers are (see toolLoop.js): it drives the CLI's own opaque agent loop,
 * which still has its full set of built-in tools (Bash, Read, Write, ...)
 * available to it — `--tools ""` was tried to close that gap and rejected,
 * see the comment on `capabilities` below and the `ai-workflows` project
 * memory for the five-experiment writeup. That is why `capabilities.scopedTools`
 * is `false` here: the safety boundary this provider offers is "the user's own
 * CLI, own machine, own files, same as typing in the Terminal panel" — fine
 * for read-only workflows, not for an unattended mutating one (enforced in
 * aiStore.js, not here).
 *
 * Flag spellings (`--mcp-config`, `--strict-mcp-config`, `--allowedTools`,
 * `--permission-mode bypassPermissions`, `--output-format stream-json`) were
 * checked against a real `claude --help`. `--resume <id>` combined with `-p`
 * was NOT verified against a live install — hence the fresh-session fallback
 * in `runTurn`, which turns a wrong guess here into a forgetful assistant
 * rather than a broken panel. The exact shape of `stream-json` EVENTS (as
 * opposed to the flags) was checked against fewer live runs — see
 * parseStreamEvent.js.
 *
 * Legally this is the same posture as the official Claude Agent SDK, which
 * embeds Claude Code by spawning this same binary: the user's own install
 * (never redistributed — see `resolveClaudePath`), the user's own credentials,
 * on the user's own machine.
 */
import { parseAgentLinePayload, parseStreamEvent } from "../parseStreamEvent.js";
import { resolveAllowedTools } from "../workflows.js";

const RUN_ID = "editor-ai-main"; // one AI run at a time, like TerminalPanel's SESSION_ID

// Cancelling kills the process, which exits non-zero, which is indistinguishable
// from a failed `--resume` unless we remember why it died. Without this flag the
// resume fallback below would helpfully restart the very turn the user just
// stopped — the worst possible response to a Stop button.
let cancelled = false;

async function invoke(cmd, args) {
  const { invoke: call } = await import("@tauri-apps/api/core");
  return call(cmd, args);
}

let claudePathCache = null;

/** Absolute path to the `claude` binary, resolved the same way TerminalPanel.jsx does. */
async function resolveClaudePath() {
  if (claudePathCache) return claudePathCache;
  const pairs = await invoke("detect_terminal_programs");
  const path = Object.fromEntries(pairs ?? [])?.claude ?? null;
  if (path) claudePathCache = path;
  return path;
}

/**
 * Waits (up to `timeoutMs`) for the bridge to actually finish connecting —
 * not just for the enable request to be issued. `setMcpPrefs`/
 * `configureMcpBridge` return as soon as the first connection attempt has
 * fired; the WS handshake itself can still take a moment, and every workflow
 * run spawns a FRESH `mcp/server.mjs`, so even an already-"enabled" bridge is
 * often mid-reconnect (the previous run's server just exited) rather than
 * steady-state connected. Resolves either way on timeout — if the bridge
 * still isn't connected by then, `mcp/server.mjs`'s own grace period
 * (ENGINE_MCP_GRACE_MS) gives it a little more time regardless, and the
 * reconnect loop itself now always keeps retrying (see the `mcpBridge.js`
 * fix this call exists because of — a synthetic browser-only test's near
 * instant JS-to-JS calls hid how much real Tauri IPC round trips could
 * lengthen this race).
 */
async function waitForBridgeConnected(timeoutMs = 8000) {
  const { useMcpStore } = await import("../../api/mcpBridge.js");
  if (useMcpStore.getState().status === "connected") return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe();
      resolve();
    }, timeoutMs);
    const unsubscribe = useMcpStore.subscribe((state) => {
      if (state.status === "connected") {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });
}

/** Ensures the editor's MCP bridge is listening AND connected before claude spawns. */
async function ensureBridgeEnabled() {
  const { useMcpPrefs, setMcpPrefs } = await import("../../mcpPrefs.js");
  if (!useMcpPrefs.getState().enabled) {
    // The user just explicitly triggered an AI action; requiring a separate
    // manual "turn on MCP first" step would be exactly the context-switch
    // this feature exists to remove.
    await setMcpPrefs({ enabled: true });
  }
  await waitForBridgeConnected();
}

/**
 * Runs one turn of `workflow`. `onEvent({lines, result, meta})` is called once
 * per parsed `stream-json` line, converted via `parseStreamEvent` (see that
 * module) — the same shape every provider emits, so `aiStore.js` has exactly
 * one `handleEvent` regardless of which provider is running. Resolves when the
 * process exits 0, rejects otherwise.
 *
 * `sessionId`, when present, RESUMES the CLI session that produced it, which
 * is what makes the AI panel a conversation instead of a series of strangers.
 * A resume can fail for reasons entirely outside this editor — the session
 * file expired, was cleaned up, or belongs to a CLI version that has moved on
 * — so a failed resume falls back to one fresh attempt rather than surfacing
 * "claude exited with code 1" for what is, from the user's chair, just a
 * follow-up question. The fallback loses the assistant's memory of the
 * conversation, so it says so in the transcript rather than pretending.
 */
export async function runTurn({ workflow, prompt, sessionId, systemPrompt, model, effort, cwd }, onEvent) {
  const claudePath = await resolveClaudePath();
  if (!claudePath) {
    throw new Error("Claude Code CLI not found. Install it and sign in — the same requirement as the Terminal panel.");
  }

  const { resolveServerPath } = await import("../../mcpClients.js");
  const serverPath = await resolveServerPath();
  if (!serverPath) {
    throw new Error("Could not locate this editor's own mcp/server.mjs.");
  }

  cancelled = false;
  await ensureBridgeEnabled();

  const mcpConfig = JSON.stringify({
    mcpServers: { "three-engine": { command: "node", args: [serverPath] } },
  });

  // Note the absence of `--no-session-persistence`, which this used to pass:
  // a session that is never written to disk is a session `--resume` cannot
  // find, and the whole point of the panel now is that the next message
  // continues this one.
  const buildArgs = (resume) => [
    "-p",
    prompt,
    ...(resume ? ["--resume", resume] : []),
    // Both default to empty, meaning "leave the CLI's own configuration
    // alone" — the user already chose a model in `claude`, and silently
    // overriding it from a game editor's side panel would be a surprise.
    ...(model ? ["--model", model] : []),
    ...(effort ? ["--effort", effort] : []),
    // APPEND rather than replace: the editor's house rules are additive to
    // whatever the user's own CLAUDE.md and settings already say, and
    // `--system-prompt` would throw all of that away.
    ...(systemPrompt ? ["--append-system-prompt", systemPrompt] : []),
    "--mcp-config",
    mcpConfig,
    "--strict-mcp-config",
    "--allowedTools",
    resolveAllowedTools(workflow).join(","),
    "--permission-mode",
    "bypassPermissions",
    "--output-format",
    "stream-json",
    "--verbose",
  ];

  try {
    await spawnRun(claudePath, buildArgs(sessionId), cwd, onEvent);
  } catch (err) {
    if (cancelled || !sessionId) throw err;
    onEvent({
      lines: [{ kind: "raw", text: "(could not resume the previous session — starting a fresh one, so earlier turns are forgotten)" }],
      result: null,
      meta: null,
    });
    await spawnRun(claudePath, buildArgs(null), cwd, onEvent);
  }
}

/**
 * One `claude` process, start to exit, with its stdout parsed into `onEvent`.
 *
 * The listeners are awaited BEFORE `agent_run` is invoked. The previous
 * version attached them in a floating `.then()` while the invoke raced ahead,
 * and its own comment admitted the window: a process that died immediately —
 * exactly what a bad `--resume` id produces — could exit before anything was
 * listening for `agent://exit`, leaving the turn hung forever with no error.
 * Awaiting first costs one microtask and closes it.
 */
async function spawnRun(claudePath, args, cwd, onEvent) {
  const { listen } = await import("@tauri-apps/api/event");

  let settled;
  const done = new Promise((resolve, reject) => {
    settled = { resolve, reject };
  });

  // Everything the process said on stderr, kept so a failure can report WHY.
  // "claude exited with code 1" on its own is the least useful error message
  // this provider can produce: the CLI always explains itself on stderr, and
  // throwing that explanation away left the panel saying only that something
  // had gone wrong. Capped because a runaway process should not be able to
  // grow this without bound.
  const stderr = [];

  const offLine = await listen("agent://line", ({ payload }) => {
    if (payload.id !== RUN_ID) return;
    if (payload.stream === "stderr" && payload.line?.trim() && stderr.length < 40) {
      stderr.push(payload.line.trim());
    }
    const event = parseAgentLinePayload(payload);
    if (event) onEvent(parseStreamEvent(event));
  });
  const offExit = await listen("agent://exit", ({ payload }) => {
    if (payload.id !== RUN_ID) return;
    if (payload.code === 0) settled.resolve();
    else {
      const code = payload.code ?? "unknown";
      const why = stderr.join("\n").trim();
      settled.reject(new Error(why ? `claude exited with code ${code}:\n${why}` : `claude exited with code ${code} and said nothing on stderr.`));
    }
  });

  try {
    await invoke("agent_run", { id: RUN_ID, command: claudePath, args, cwd: cwd ?? null });
    await done;
  } finally {
    offLine();
    offExit();
  }
}

export async function cancelTurn() {
  cancelled = true;
  await invoke("agent_cancel", { id: RUN_ID });
}

/** This provider, registered in providers/index.js. */
export const claudeCliProvider = {
  id: "claude-cli",
  label: "Claude Code CLI (subscription)",
  capabilities: { scopedTools: false, isLocal: false, needsApiKey: false },
  disclosure:
    "Runs with your full Claude Code permissions — the same access as typing directly into the Terminal panel. " +
    "Fine for read-only actions; mutating workflows are refused on this provider.",
  runTurn,
  cancelTurn,
};
