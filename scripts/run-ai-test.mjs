// AI workflow parsing test. No browser, no Tauri, no real `claude` process —
// just the pure pieces of the point-of-intent AI feature exercised directly.
//
//   node scripts/run-ai-test.mjs
//
// `providers/claudeCli.js` and `aiStore.js` both need a live Tauri webview to
// actually run a turn (agent_run/agent_cancel, event listeners), so this
// deliberately does not import them: importing `aiStore.js` pulls in
// `store/projectStore.js`, whose chain hits a Vite-only `.d.ts` import plain
// Node can't load. What CAN be tested here without any of that is exactly the
// part most likely to silently rot — the parsing — because
// `src/editor/ai/parseStreamEvent.js` is deliberately dependency-free (see its
// module doc), and `resolveAllowedTools` in `workflows.js` only needs
// `api/registry.js`, which has zero imports of its own.
//
// `smoke:ai` (not yet written) is the other half: a real editor, a real
// `claude` CLI, and the actual context-menu action end to end.
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { parseAgentLinePayload, parseStreamEvent } from "../src/editor/ai/parseStreamEvent.js";
import { WORKFLOWS, getWorkflow, workflowTools, resolveAllowedTools, resolveToolSchemas } from "../src/editor/ai/workflows.js";
import { makeAiContext, describeContexts, addContext, contextKey } from "../src/editor/ai/context.js";
import { createToolLoopProvider } from "../src/editor/ai/providers/toolLoop.js";
import { defineOp, resetOps } from "../src/editor/api/registry.js";
import { MCP_SERVER_NAME } from "../src/editor/mcpClients.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- 1. parseAgentLinePayload: raw agent://line payload -> event or null ----

check(
  "a valid JSON stdout line parses to its object",
  deepEqual(parseAgentLinePayload({ stream: "stdout", line: '{"type":"result","result":"ok"}' }), {
    type: "result",
    result: "ok",
  }),
);

check(
  "an invalid-JSON stdout line falls back to a raw stdout event",
  deepEqual(parseAgentLinePayload({ stream: "stdout", line: "not json {" }), {
    type: "raw",
    stream: "stdout",
    text: "not json {",
  }),
);

check(
  "a non-empty stderr line becomes a raw stderr event",
  deepEqual(parseAgentLinePayload({ stream: "stderr", line: "warning: something" }), {
    type: "raw",
    stream: "stderr",
    text: "warning: something",
  }),
);

check("a blank stdout line is skipped (null)", parseAgentLinePayload({ stream: "stdout", line: "   " }) === null);
check("a blank stderr line is skipped (null)", parseAgentLinePayload({ stream: "stderr", line: "" }) === null);

// --- 2. parseStreamEvent: parsed event -> display lines + result ------------

check(
  "a non-object event produces nothing",
  deepEqual(parseStreamEvent(null), { lines: [], result: null, meta: null }),
);

check(
  "a system/init event without a model produces nothing, not a raw JSON dump",
  deepEqual(parseStreamEvent({ type: "system", subtype: "thinking_tokens", estimated_tokens: 50 }), {
    lines: [],
    result: null,
    meta: null,
  }),
);

check(
  "…but a system/init event WITH a model surfaces just that, not the rest of the multi-KB blob",
  deepEqual(
    parseStreamEvent({ type: "system", subtype: "init", model: "claude-sonnet-5", tools: ["a", "b"], mcp_servers: [] }),
    { lines: [], result: null, meta: { model: "claude-sonnet-5" } },
  ),
);

check(
  "a rate_limit_event produces nothing either",
  deepEqual(parseStreamEvent({ type: "rate_limit_event", rate_limit_info: { utilization: 0.5 } }), {
    lines: [],
    result: null,
    meta: null,
  }),
);

check(
  "an assistant text block becomes a text line",
  deepEqual(
    parseStreamEvent({ type: "assistant", message: { content: [{ type: "text", text: "Looks fine." }] } }).lines,
    [{ kind: "text", text: "Looks fine." }],
  ),
);

// The transcript shows a call's IDENTITY, never its arguments in full. The raw
// form (full MCP name + JSON.stringify(input)) is what buried the answer under
// a wall of escaped JSON in the shipped panel — see ToolTrail's note.
check(
  "a tool_use line strips the mcp__<server>__ prefix and reads as a dotted op name",
  deepEqual(
    parseStreamEvent({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "mcp__three-engine__entity_get", input: { id: "e1" } }] },
    }).lines,
    [{ kind: "tool_call", text: "entity.get e1" }],
  ),
  JSON.stringify(
    parseStreamEvent({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "mcp__three-engine__entity_get", input: { id: "e1" } }] },
    }).lines,
  ),
);

check(
  "a tool_use block with no input is just the name",
  deepEqual(
    parseStreamEvent({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "mcp__three-engine__console_read", input: {} }] },
    }).lines,
    [{ kind: "tool_call", text: "console.read" }],
  ),
);

check(
  "a non-MCP built-in tool keeps its own name",
  parseStreamEvent({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
  }).lines[0].text === "Bash ls",
);

{
  // The exact shape from the live panel that prompted this: a Bash call whose
  // command is a 300-character `cd ... && node -e ...` one-liner.
  const long = `cd "C:/Users/Khudiiash/Documents/GAME" && node -e "${"x".repeat(400)}"`;
  const { lines } = parseStreamEvent({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command: long } }] },
  });
  check(
    "a long command argument is clipped to a hint, never printed in full",
    lines[0].text.length <= 60 && lines[0].text.endsWith("…"),
    `${lines[0].text.length} chars: ${lines[0].text}`,
  );
}

{
  // A big object argument with no hint key must not fall back to dumping JSON.
  const { lines } = parseStreamEvent({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "mcp__three-engine__batch", input: { ops: [1, 2, 3], extra: { a: 1 } } }] },
  });
  check(
    "arguments with no recognizable hint key produce the bare name, NOT a JSON dump",
    lines[0].text === "batch",
    lines[0].text,
  );
}

// Successful results are dropped entirely: one `entity_list` is 120 kB, and
// even a clipped preview reads as escaped garbage between question and answer.
check(
  "a SUCCESSFUL tool_result produces no line at all",
  deepEqual(
    parseStreamEvent({
      type: "user",
      message: { content: [{ type: "tool_result", content: "a".repeat(5000) }] },
    }).lines,
    [],
  ),
);

check(
  "…but a FAILED tool_result still surfaces, because the call line alone isn't the whole story",
  deepEqual(
    parseStreamEvent({
      type: "user",
      message: { content: [{ type: "tool_result", is_error: true, content: "No entity with id \"e9\"." }] },
    }).lines,
    [{ kind: "tool_result", text: 'No entity with id "e9".' }],
  ),
);

{
  const long = "x".repeat(500);
  const { lines } = parseStreamEvent({
    type: "user",
    message: { content: [{ type: "tool_result", is_error: true, content: long }] },
  });
  check(
    "a long ERROR is truncated rather than dumped in full",
    lines[0].text.length === 161 && lines[0].text.endsWith("…"),
    `got length ${lines[0].text.length}`,
  );
}

check(
  "a result event surfaces its text as the final result, not a line",
  deepEqual(parseStreamEvent({ type: "result", result: "Nothing looks wrong." }).result, "Nothing looks wrong."),
);

check(
  "…and pulls cost/duration/turns/tokens into meta, so the panel can show what a run actually spent",
  deepEqual(
    parseStreamEvent({
      type: "result",
      result: "ok",
      duration_ms: 8300,
      total_cost_usd: 0.1345,
      num_turns: 3,
      usage: { input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 12000 },
    }).meta,
    { durationMs: 8300, costUsd: 0.1345, turns: 3, tokens: 12210 },
  ),
);

check(
  "a result event missing the usual fields (unexpected CLI shape) reports nulls, not a crash",
  deepEqual(parseStreamEvent({ type: "result", result: "ok" }).meta, {
    durationMs: null,
    costUsd: null,
    turns: null,
    tokens: null,
  }),
);

// The session id is what makes the panel a CONVERSATION rather than a series
// of strangers: it is fed back as `--resume` on the next message.
check(
  "a system/init event surfaces the session id alongside the model",
  deepEqual(
    parseStreamEvent({ type: "system", subtype: "init", model: "m", session_id: "sess-42" }).meta,
    { model: "m", sessionId: "sess-42" },
  ),
);
check(
  "a result event carries the session id too, so a resumed turn keeps the thread",
  parseStreamEvent({ type: "result", result: "ok", session_id: "sess-42" }).meta.sessionId === "sess-42",
);
check(
  "a result event WITHOUT a session id omits the key rather than merging a null over the live one",
  !("sessionId" in parseStreamEvent({ type: "result", result: "ok" }).meta),
);

check(
  "a raw event (from parseAgentLinePayload's fallback) passes its text through",
  deepEqual(parseStreamEvent({ type: "raw", stream: "stderr", text: "hm" }).lines, [{ kind: "raw", text: "hm" }]),
);

check(
  "an unrecognized event shape is surfaced as raw JSON, not silently dropped",
  deepEqual(parseStreamEvent({ type: "some_future_event", weird: true }).lines, [
    { kind: "raw", text: '{"type":"some_future_event","weird":true}' },
  ]),
);

// --- 3. workflows.js: the registry and its allowedTools resolution ----------

check("exactly one workflow is registered", WORKFLOWS.length === 1, `${WORKFLOWS.length} workflows`);
check("getWorkflow finds `ask` by id", getWorkflow("ask")?.label === "Ask AI");
check("getWorkflow returns null for an unknown id", getWorkflow("nope") === null);
check(
  "the retired one-shot diagnose workflow is gone — the panel is a conversation now",
  getWorkflow("diagnose-selected") === null,
);

const ask = getWorkflow("ask");

check(
  "`ask` is marked interactive, which is what exempts it from the unattended-mutating-run guard",
  ask.interactive === true && ask.mutates === true,
);

// `"*"` means the whole live registry. Register a couple of fakes and confirm
// the resolution follows the registry rather than any list pinned in the file.
resetOps();
defineOp({ name: "entity.get", description: "fake", readOnly: true, run: () => null });
defineOp({ name: "entity.create", description: "fake", readOnly: false, run: () => null });

{
  const tools = workflowTools(ask);
  check(
    'allowedTools "*" resolves to EVERY registered op, not a hardcoded subset',
    deepEqual([...tools].sort(), ["entity.create", "entity.get"]),
    tools.join(", "),
  );

  const resolved = resolveAllowedTools(ask);
  check(
    "resolveAllowedTools returns one mcp__<server>__<tool> name per op, dots underscored",
    deepEqual(resolved, ["entity.create", "entity.get"].map((n) => `mcp__${MCP_SERVER_NAME}__${n.replaceAll(".", "_")}`)),
    resolved.join(", "),
  );
  check(
    "no resolved name kept a dot (would break --allowedTools)",
    resolved.every((n) => !n.slice(`mcp__${MCP_SERVER_NAME}__`.length).includes(".")),
  );
}

{
  // A new op appearing in the registry must widen "*" with no edit here — the
  // whole reason "*" exists rather than a pinned list that silently goes stale.
  defineOp({ name: "scene.get", description: "fake", readOnly: true, run: () => null });
  check(
    'a newly registered op is picked up by "*" automatically',
    workflowTools(ask).includes("scene.get"),
  );
}

{
  let threw = null;
  try {
    workflowTools({ id: "fake", allowedTools: ["entity.get", "not.a.real.op"] });
  } catch (err) {
    threw = err;
  }
  check(
    "an EXPLICIT allowedTools list with an unknown op still throws instead of silently narrowing",
    threw !== null && /not\.a\.real\.op/.test(threw.message),
    threw?.message,
  );
}
resetOps();

// --- 4. context.js: the anchors, and the paragraph the model reads ---------

check(
  "makeAiContext normalizes a bare string ref into an array",
  deepEqual(makeAiContext("entity", "e1").refs, ["e1"]),
);
check(
  "…and drops non-string junk rather than passing it to the model",
  deepEqual(makeAiContext("entity", ["e1", null, 7, ""]).refs, ["e1"]),
);
check(
  "a single asset context labels itself with the basename, not the whole path",
  makeAiContext("asset", ["textures/rock/albedo.png"]).label === "albedo.png",
);
check(
  "an attached FILE labels itself with the basename too — an absolute path is unreadable in a chip",
  makeAiContext("file", ["C:\\Users\\me\\notes.md"]).label === "notes.md",
  makeAiContext("file", ["C:\\Users\\me\\notes.md"]).label,
);
check(
  "a multi-ref context labels itself with a count and a REAL plural (not 'entitys')",
  makeAiContext("entity", ["a", "b", "c"]).label === "3 entities",
  makeAiContext("entity", ["a", "b", "c"]).label,
);
check("an explicit label wins over the derived one", makeAiContext("entity", ["e1"], "Player").label === "Player");

// Chips are a SET, keyed by what they point at: dragging the same entity in
// twice must not grow the row.
{
  const a = makeAiContext("entity", ["e1"]);
  const b = makeAiContext("entity", ["e1"], "Renamed");
  const c = makeAiContext("asset", ["rock.png"]);
  check("contextKey ignores the label — the same ref is the same chip", contextKey(a) === contextKey(b));
  check("addContext replaces a chip naming the same thing", deepEqual(addContext([a], b), [b]));
  check("…and appends a chip naming something different", addContext([a], c).length === 2);
  check(
    "a different KIND with the same ref string is a different chip",
    contextKey(makeAiContext("asset", ["x"])) !== contextKey(makeAiContext("file", ["x"])),
  );
}

check("describeContexts returns '' for no chips — a real state, not an error", describeContexts([]) === "");
check("…and for null", describeContexts(null) === "");
check(
  "an entity chip names the ids AND points at the op that reads them",
  /e1/.test(describeContexts([makeAiContext("entity", ["e1"])])) &&
    /entity\.get/.test(describeContexts([makeAiContext("entity", ["e1"])])),
);
check(
  "an asset chip names the paths and points at asset.read",
  /rock\.png/.test(describeContexts([makeAiContext("asset", ["rock.png"])])) &&
    /asset\.read/.test(describeContexts([makeAiContext("asset", ["rock.png"])])),
);
check(
  "a file chip tells the model to read the attached path",
  /notes\.md/.test(describeContexts([makeAiContext("file", ["/tmp/notes.md"])])),
);
check(
  "a viewport chip asks the model to TAKE the screenshot rather than staging bytes",
  /viewport\.screenshot/.test(describeContexts([makeAiContext("viewport", [])])),
);
check(
  "a scene chip points at scene.get rather than naming refs it doesn't have",
  /scene\.get/.test(describeContexts([makeAiContext("scene", [])])),
);
check(
  "several chips all appear in one paragraph — the question can be about more than one thing",
  (() => {
    const text = describeContexts([makeAiContext("entity", ["e1"]), makeAiContext("asset", ["rock.png"])]);
    return text.includes("e1") && text.includes("rock.png");
  })(),
);

// buildPrompt: chips ride along with the message they were attached to.
{
  const contexts = [makeAiContext("entity", ["e1"])];
  const prompt = ask.buildPrompt({ text: "why is this dark?", contexts });
  check(
    "buildPrompt prepends the context paragraph and keeps the user's text last",
    prompt.includes("e1") && prompt.endsWith("why is this dark?"),
  );
  check(
    "with no chips at all, the prompt is exactly what the user typed",
    ask.buildPrompt({ text: "hello", contexts: [] }) === "hello",
  );
}

// --- 5. resolveToolSchemas: the OpenAI-shaped tool list toolLoop.js sends ---

resetOps();
defineOp({
  name: "entity.get",
  description: "Get an entity by id.",
  readOnly: true,
  params: { id: { type: "string", required: true, description: "Entity id" } },
  run: () => null,
});
defineOp({ name: "entity.list", description: "List entities.", readOnly: true, run: () => null });

{
  const schemas = resolveToolSchemas({ id: "fake-schema", allowedTools: ["entity.get", "entity.list"] });
  check("resolveToolSchemas returns one entry per allowed op", schemas.length === 2, `${schemas.length}`);
  check(
    "each entry is OpenAI function-tool shaped ({type:'function', function:{name, description, parameters}})",
    schemas.every(
      (s) =>
        s.type === "function" &&
        typeof s.function?.name === "string" &&
        typeof s.function?.description === "string" &&
        typeof s.function?.parameters === "object",
    ),
    JSON.stringify(schemas[0]),
  );
  check(
    "dots in the op name become underscores in function.name (an OpenAI tool name may not contain a dot)",
    schemas.find((s) => s.function.name === "entity_get") !== undefined && schemas.every((s) => !s.function.name.includes(".")),
    schemas.map((s) => s.function.name).join(", "),
  );
  check(
    "parameters is a real JSON Schema object (type:object, with properties)",
    schemas.find((s) => s.function.name === "entity_get").function.parameters.type === "object" &&
      schemas.find((s) => s.function.name === "entity_get").function.parameters.properties?.id?.type === "string",
  );
}

{
  let threw = null;
  try {
    resolveToolSchemas({ id: "fake", allowedTools: ["entity.get", "not.a.real.op"] });
  } catch (err) {
    threw = err;
  }
  check(
    "resolveToolSchemas: an unknown op name throws instead of silently narrowing the tool list",
    threw !== null && /not\.a\.real\.op/.test(threw.message),
    threw?.message,
  );
}
resetOps();

// --- 6. toolLoop.js: the closed agent loop, driven against a fake transport
//
// createToolLoopProvider() no longer calls `fetch` — it calls an injected
// `transport({url, apiKey, body}) => Promise<string>`, which in production
// routes through the `ai_chat` Rust command (see toolLoop.js's module doc
// and its `defaultTransport`). Injecting a fake transport here is simpler
// and more honest than stubbing a global: it exercises the exact seam the
// real code calls through, with no real network, no real model, no Tauri.

function makeLoopProvider(impl) {
  return createToolLoopProvider({
    id: "test-loop",
    label: "Test Loop",
    baseUrl: "http://fake-host",
    model: "test-model",
    apiKey: "",
    transport: impl,
  });
}

// 6a. finish_reason:"stop" ends the loop in one round trip.
{
  resetOps();
  defineOp({ name: "entity.get", description: "Get an entity.", readOnly: true, run: () => ({ ok: true }) });
  const workflow = { id: "loop-stop", allowedTools: ["entity.get"] };

  const transportCalls = [];
  const events = [];
  let threw = null;
  const provider = makeLoopProvider(async ({ url, body }) => {
    transportCalls.push({ url, body: JSON.parse(body) });
    return JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "All good." } }] });
  });
  try {
    await provider.runTurn({ workflow, prompt: "diagnose" }, (e) => events.push(e));
  } catch (err) {
    threw = err;
  }

  check("a finish_reason:'stop' response ends the loop in one round trip", threw === null && transportCalls.length === 1, `${transportCalls.length} calls, threw=${threw?.message}`);
  const final = events[events.length - 1];
  check("...and surfaces message.content as the result passed to onEvent", final?.result === "All good.", JSON.stringify(final));
  check("meta carries the model up front, in the first event", events[0]?.meta?.model === "test-model", JSON.stringify(events[0]));
  check(
    "meta carries turns/durationMs at the end",
    final?.meta?.turns === 1 && typeof final.meta.durationMs === "number",
    JSON.stringify(final?.meta),
  );
  resetOps();
}

// 6b. finish_reason:"tool_calls" actually executes the op, and the follow-up
// request body feeds the result back as a role:"tool" message.
{
  resetOps();
  let getCalls = 0;
  defineOp({
    name: "entity.get",
    description: "Get an entity.",
    readOnly: true,
    params: { id: { type: "string", required: true } },
    run: ({ id }) => {
      getCalls += 1;
      return { id, name: "Thing" };
    },
  });
  const workflow = { id: "loop-tools", allowedTools: ["entity.get"] };

  const transportCalls = [];
  let call = 0;
  const provider = makeLoopProvider(async ({ body }) => {
    call += 1;
    transportCalls.push({ body: JSON.parse(body) });
    if (call === 1) {
      return JSON.stringify({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              tool_calls: [{ id: "call_1", function: { name: "entity_get", arguments: JSON.stringify({ id: "e1" }) } }],
            },
          },
        ],
      });
    }
    return JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Diagnosis: fine." } }] });
  });
  await provider.runTurn({ workflow, prompt: "diagnose" }, () => {});

  check("a tool_calls response actually executes the named op", getCalls === 1, `getCalls=${getCalls}`);
  const toolMsg = transportCalls[1]?.body.messages.find((m) => m.role === "tool" && m.tool_call_id === "call_1");
  check(
    "the SECOND request body carries a {role:'tool', tool_call_id, content} message with that op's result",
    !!toolMsg && JSON.parse(toolMsg.content).ok === true && JSON.parse(toolMsg.content).result.name === "Thing",
    JSON.stringify(toolMsg),
  );
  resetOps();
}

// 6b-image. A tool result carrying an image (what `viewport.screenshot`
// returns) must NEVER put its base64 into the conversation. A `role:"tool"`
// message is plain text, so those bytes are not a picture the model can see —
// they are ~1 MB of gibberish that buries the real results, blows a local
// model's context, and invites it to invent a description. This shipped
// broken once: a small local model confidently described a Genshin Impact
// screenshot, HP bars and all, for a scene containing a single light.
{
  resetOps();
  const base64 = "iVBORw0KGgoAAAANSUhEUg" + "A".repeat(4000);
  defineOp({
    name: "viewport.screenshot",
    description: "Screenshot the viewport.",
    readOnly: true,
    run: () => ({ __image: { mimeType: "image/png", base64 } }),
  });
  const workflow = { id: "loop-image", allowedTools: ["viewport.screenshot"] };

  const bodies = [];
  let call = 0;
  const provider = makeLoopProvider(async ({ body }) => {
    call += 1;
    bodies.push(JSON.parse(body));
    if (call === 1) {
      return JSON.stringify({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              tool_calls: [{ id: "call_1", function: { name: "viewport_screenshot", arguments: "{}" } }],
            },
          },
        ],
      });
    }
    return JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Done." } }] });
  });
  await provider.runTurn({ workflow, prompt: "diagnose" }, () => {});

  const toolMsg = bodies[1]?.messages.find((m) => m.role === "tool");
  const sent = JSON.stringify(bodies[1] ?? {});
  check(
    "an image tool result NEVER sends its base64 bytes into the conversation",
    !sent.includes(base64.slice(0, 64)),
    `request body length ${sent.length}`,
  );
  check(
    "...and the model is told explicitly it has NOT seen the image, so it has no excuse to describe it",
    /NOT shown to you|have not seen it/i.test(toolMsg?.content ?? ""),
    toolMsg?.content,
  );
  resetOps();
}

// 6c. the allowlist guard — the load-bearing safety check of the whole
// feature. A tool_calls response naming something outside the workflow's
// allowedTools must not execute, and must feed back an error.
{
  resetOps();
  let listCalls = 0;
  defineOp({ name: "entity.get", description: "Get an entity.", readOnly: true, run: () => ({ ok: true }) });
  defineOp({
    name: "entity.list",
    description: "List entities.",
    readOnly: true,
    run: () => {
      listCalls += 1;
      return [];
    },
  });
  // entity.list is a REAL, registered op — but NOT on this workflow's allowlist.
  const workflow = { id: "loop-allowlist", allowedTools: ["entity.get"] };

  const transportCalls = [];
  let call = 0;
  const provider = makeLoopProvider(async ({ body }) => {
    call += 1;
    transportCalls.push({ body: JSON.parse(body) });
    if (call === 1) {
      return JSON.stringify({
        choices: [
          {
            finish_reason: "tool_calls",
            message: { role: "assistant", tool_calls: [{ id: "call_x", function: { name: "entity_list", arguments: "{}" } }] },
          },
        ],
      });
    }
    return JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }] });
  });
  await provider.runTurn({ workflow, prompt: "x" }, () => {});

  check(
    "a tool_calls response naming a tool NOT in the workflow's allowedTools is NEVER executed",
    listCalls === 0,
    `listCalls=${listCalls}`,
  );
  const guardMsg = transportCalls[1]?.body.messages.find((m) => m.role === "tool" && m.tool_call_id === "call_x");
  check(
    "...and an error is fed back as that call's tool result instead of silently dropping it",
    !!guardMsg && JSON.parse(guardMsg.content).ok === false,
    guardMsg?.content,
  );
  resetOps();
}

// 6d. malformed function.arguments JSON is fed back as a tool error, not thrown.
{
  resetOps();
  defineOp({ name: "entity.get", description: "Get an entity.", readOnly: true, run: () => ({ ok: true }) });
  const workflow = { id: "loop-malformed", allowedTools: ["entity.get"] };

  let capturedToolMsg = null;
  let call = 0;
  let threw = null;
  const provider = makeLoopProvider(async ({ body: rawBody }) => {
    call += 1;
    const body = JSON.parse(rawBody);
    if (call === 1) {
      return JSON.stringify({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              tool_calls: [{ id: "call_bad", function: { name: "entity_get", arguments: "{not valid json" } }],
            },
          },
        ],
      });
    }
    capturedToolMsg = body.messages.find((m) => m.role === "tool" && m.tool_call_id === "call_bad");
    return JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "recovered" } }] });
  });
  try {
    await provider.runTurn({ workflow, prompt: "x" }, () => {});
  } catch (err) {
    threw = err;
  }

  check("malformed function.arguments JSON does not throw out of the run", threw === null, threw?.message);
  check(
    "...and is fed back as a tool error instead",
    !!capturedToolMsg && JSON.parse(capturedToolMsg.content).ok === false,
    capturedToolMsg?.content,
  );
  resetOps();
}

// 6e. the iteration cap (12) terminates a server that returns tool_calls forever.
{
  resetOps();
  defineOp({ name: "entity.get", description: "Get an entity.", readOnly: true, run: () => ({ ok: true }) });
  const workflow = { id: "loop-cap", allowedTools: ["entity.get"] };

  let call = 0;
  const events = [];
  const provider = makeLoopProvider(async () => {
    call += 1;
    return JSON.stringify({
      choices: [
        {
          finish_reason: "tool_calls",
          message: { role: "assistant", tool_calls: [{ id: `call_${call}`, function: { name: "entity_get", arguments: "{}" } }] },
        },
      ],
    });
  });
  await provider.runTurn({ workflow, prompt: "x" }, (e) => events.push(e));

  check("a server that returns tool_calls forever is stopped by the iteration cap, not looped unbounded", call === 12, `${call} transport calls`);
  const final = events[events.length - 1];
  check(
    "...the cap is surfaced through onEvent (a text line + meta.turns), not a silent hang",
    final?.meta?.turns === 12 && /stopped after/.test(final?.lines?.[0]?.text ?? ""),
    JSON.stringify(final),
  );
  resetOps();
}

// 6f. a transport rejection (what a non-2xx HTTP response becomes, once the
// Rust `ai_chat` command turns it into a rejected promise carrying the
// status + response body — see its doc comment in src-tauri/src/lib.rs)
// surfaces as a readable error naming the base URL.
{
  resetOps();
  defineOp({ name: "entity.get", description: "Get an entity.", readOnly: true, run: () => ({ ok: true }) });
  const workflow = { id: "loop-http-error", allowedTools: ["entity.get"] };

  const provider = makeLoopProvider(async ({ url }) => {
    throw new Error(`${url} returned 500: internal error`);
  });

  let threw = null;
  try {
    await provider.runTurn({ workflow, prompt: "x" }, () => {});
  } catch (err) {
    threw = err;
  }

  check(
    "a transport rejection surfaces as a readable error naming the base URL",
    threw !== null && threw.message.includes("http://fake-host"),
    threw?.message,
  );
  resetOps();
}

// 6g. multi-turn: prior history is replayed into the request, because this
// loop holds no session of its own the way the `claude` CLI does. Without it
// the second question in a conversation reaches an assistant with amnesia.
{
  resetOps();
  defineOp({ name: "entity.get", description: "Get an entity.", readOnly: true, run: () => ({ ok: true }) });
  const workflow = { id: "loop-history", allowedTools: ["entity.get"] };

  let sent = null;
  const provider = makeLoopProvider(async ({ body }) => {
    sent = JSON.parse(body);
    return JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "still Player" } }] });
  });
  await provider.runTurn(
    {
      workflow,
      prompt: "and what was its name again?",
      systemPrompt: "CUSTOM SYSTEM",
      history: [
        { role: "user", content: "what is selected?" },
        { role: "assistant", content: "An entity called Player." },
      ],
    },
    () => {},
  );

  check(
    "prior history is replayed between the system prompt and the new message, in order",
    deepEqual(
      sent.messages.map((m) => m.role),
      ["system", "user", "assistant", "user"],
    ),
    JSON.stringify(sent.messages.map((m) => m.role)),
  );
  check(
    "...carrying the actual earlier text, not just the roles",
    sent.messages[2].content === "An entity called Player." && sent.messages[3].content === "and what was its name again?",
  );
  check(
    "the workflow's own system prompt is used when it supplies one",
    sent.messages[0].content === "CUSTOM SYSTEM",
    sent.messages[0].content,
  );
  resetOps();
}

// 6h. the allowlist guard must follow the RESOLVED tool set, not the literal
// `allowedTools` value — a workflow declaring "*" would otherwise guard against
// the string "*", which matches nothing, and refuse every call it just offered.
{
  resetOps();
  let getCalls = 0;
  defineOp({
    name: "entity.get",
    description: "Get an entity.",
    readOnly: true,
    run: () => {
      getCalls += 1;
      return { ok: true };
    },
  });
  const workflow = { id: "loop-star", allowedTools: "*" };

  let call = 0;
  const provider = makeLoopProvider(async () => {
    call += 1;
    if (call === 1) {
      return JSON.stringify({
        choices: [
          {
            finish_reason: "tool_calls",
            message: { role: "assistant", tool_calls: [{ id: "c1", function: { name: "entity_get", arguments: "{}" } }] },
          },
        ],
      });
    }
    return JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }] });
  });
  await provider.runTurn({ workflow, prompt: "x" }, () => {});

  check('a workflow declaring "*" can actually CALL the ops it was offered', getCalls === 1, `getCalls=${getCalls}`);
  resetOps();
}

// --- summary ------------------------------------------------------------------

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log("Failed:", failed.map((r) => r.name).join(", "));
  process.exit(1);
}
