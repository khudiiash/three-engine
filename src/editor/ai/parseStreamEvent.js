/**
 * Pure parsing for a headless `claude -p --output-format stream-json` run.
 * Zero dependencies on purpose: `providers/claudeCli.js` and `aiStore.js` both
 * need editor/Tauri machinery to actually RUN a turn, but the parsing itself
 * doesn't, and keeping it dependency-free is what makes it testable directly
 * from a plain Node script (see scripts/run-ai-test.mjs) instead of needing a
 * live Tauri webview or a real `claude` process.
 */

/**
 * Turns one raw `agent://line` event payload (from agent.rs, see agent.rs's
 * module doc) into a parsed `stream-json` event, or a `{type:"raw",...}`
 * fallback for stderr output or a stdout line that wasn't valid JSON (a CLI
 * version whose stream-json shape differs from what parseStreamEvent below
 * assumes). Returns null for a blank line, which callers should just skip.
 */
export function parseAgentLinePayload({ stream, line }) {
  if (stream !== "stdout") {
    return line?.trim() ? { type: "raw", stream: "stderr", text: line } : null;
  }
  if (!line?.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return { type: "raw", stream: "stdout", text: line };
  }
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Argument keys worth showing, best first. One short value identifies a call
 * ("entity.get fYKenR1LuZ") without turning the transcript into a JSON dump.
 */
const HINT_KEYS = ["id", "entityId", "path", "name", "query", "command", "type"];

/**
 * One tool call, as a person would read it: `entity.get fYKenR1LuZ`.
 *
 * The raw form — the full MCP tool name plus `JSON.stringify(input)` — is what
 * made the panel unreadable in practice. A single `ToolSearch` call printed a
 * 300-character query, `entity_list` printed its whole result, and the
 * transcript became a wall of escaped JSON with the actual answer lost in it.
 * The call's IDENTITY is what a person watching wants ("it's reading the
 * entity"); the arguments are debugging detail, so at most one short hint
 * survives.
 */
export function summarizeCall(name, input) {
  const label = String(name ?? "tool")
    .replace(/^mcp__[^_]+(?:-[^_]+)*__/, "")
    .replaceAll("_", ".");
  if (!input || typeof input !== "object") return label;
  for (const key of HINT_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return `${label} ${truncate(value.trim(), 48)}`;
    if (typeof value === "number") return `${label} ${value}`;
  }
  return label;
}

/**
 * Event types confirmed (2026-08-04, CLI v2.1.221) to open every `-p
 * --output-format stream-json` run: a `system`/`init` event carrying the full
 * tool list, model, mcp server statuses etc., and a `rate_limit_event`.
 * Neither is content for the log — but `init` carries the run's `model`,
 * worth pulling into `meta` before the rest of it is discarded (see below;
 * a user watching a run has no other way to tell which model answered, or
 * how many tool calls / tokens / dollars it took — the whole point of a
 * "what's it doing" panel is answering that, not just showing the request
 * text). Bare `type` values without the object shapes `assistant`/`user`/
 * `result` need are checked for, since a future CLI version could add more.
 */
const IGNORED_EVENT_TYPES = new Set(["rate_limit_event"]);

function formatTokens(usage) {
  if (!usage) return null;
  const total = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  return total > 0 ? total : null;
}

/**
 * Turns one parsed `stream-json` event into zero or more display lines, an
 * optional final answer (`result`), and any run metadata it revealed
 * (`meta` — a PARTIAL object; callers merge it into what they already know
 * rather than replace). Handles the shapes confirmed against a real
 * `claude -p --output-format stream-json` run: `system`/`init` (model),
 * `assistant`/`user` events carrying a `message.content` block array, and a
 * final `result` event carrying the answer plus cost/duration/token counts.
 * `tool_use`/`tool_result` content blocks follow the same Anthropic Messages
 * format but were exercised only lightly by real runs so far — high
 * confidence, not exhaustively verified. Anything unrecognized is surfaced
 * as a raw line rather than silently dropped, so a future CLI version that
 * changes shape fails visibly instead of just going quiet.
 */
export function parseStreamEvent(event) {
  const lines = [];
  let result = null;
  let meta = null;

  if (!event || typeof event !== "object") return { lines, result, meta };
  if (IGNORED_EVENT_TYPES.has(event.type)) return { lines, result, meta };

  if (event.type === "system") {
    // `init` opens every run. Beyond the model it carries the run's
    // `session_id` — load-bearing now that the AI panel is a CONVERSATION
    // rather than a one-shot: the next message resumes this session instead
    // of starting a fresh, amnesiac one (see providers/claudeCli.js).
    if (event.subtype === "init") {
      const found = {};
      if (event.model) found.model = event.model;
      if (event.session_id) found.sessionId = event.session_id;
      if (Object.keys(found).length) meta = found;
    }
    return { lines, result, meta };
  }

  if (event.type === "assistant" && Array.isArray(event.message?.content)) {
    for (const block of event.message.content) {
      if (block.type === "text" && block.text) {
        lines.push({ kind: "text", text: block.text });
      } else if (block.type === "tool_use") {
        lines.push({ kind: "tool_call", text: summarizeCall(block.name, block.input) });
      }
    }
    return { lines, result, meta };
  }

  if (event.type === "user" && Array.isArray(event.message?.content)) {
    for (const block of event.message.content) {
      // Successful results are DROPPED, not truncated. The call line above
      // already says what happened, and a result is the single noisiest thing
      // a transcript can carry: one `entity_list` is 120 kB of JSON, and even
      // clipped to a preview it reads as escaped garbage stacked between the
      // question and the answer. Only a FAILURE earns a line, because that is
      // the one case where the call line alone is not the whole story.
      if (block.type === "tool_result" && block.is_error) {
        const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        lines.push({ kind: "tool_result", text: truncate(text, 160) });
      }
    }
    return { lines, result, meta };
  }

  if (event.type === "result") {
    result = event.result ?? event.summary ?? null;
    meta = {
      durationMs: typeof event.duration_ms === "number" ? event.duration_ms : null,
      costUsd: typeof event.total_cost_usd === "number" ? event.total_cost_usd : null,
      turns: typeof event.num_turns === "number" ? event.num_turns : null,
      tokens: formatTokens(event.usage),
      // Repeated here as well as on `init` because a resumed turn's id is
      // the one that matters for the turn AFTER it, and a run that somehow
      // missed its init event would otherwise lose the thread.
      ...(event.session_id ? { sessionId: event.session_id } : {}),
    };
    return { lines, result, meta };
  }

  if (event.type === "raw") {
    lines.push({ kind: "raw", text: event.text });
    return { lines, result, meta };
  }

  lines.push({ kind: "raw", text: JSON.stringify(event) });
  return { lines, result, meta };
}
