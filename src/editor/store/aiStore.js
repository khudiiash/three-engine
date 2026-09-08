/**
 * The AI conversations — their transcripts, their anchors, and the
 * orchestration that runs one turn.
 *
 * This used to hold a single fire-and-forget workflow run, which is why the
 * panel could only ever be watched, never talked to. It now holds what a chat
 * client holds: a list of conversations, one of them active, each with its own
 * transcript and its own provider session (`sessionId`, resumed by
 * `providers/claudeCli.js`) so a follow-up continues the thread rather than
 * meeting a stranger.
 *
 * History is persisted to localStorage, deliberately WITHOUT the tool-call
 * trails: those are progress, not content — they are the bulkiest part of a
 * transcript and the least worth reading a week later. What survives a restart
 * is the questions, the answers, and the anchor.
 *
 * `vmSingleton`-wrapped for the same reason as `commandBus`, the MCP stores,
 * and the terminal's session map — see singleton.js. A duplicate copy under
 * Vite HMR would mean AiPanel.jsx renders from a store nothing writes into,
 * which looks exactly like "the feature doesn't work" (this exact class of
 * bug has hit commandBus, useHistoryStore, useSceneStore, useSelectionStore,
 * useMcpStore and the terminal panel before).
 */
import { create } from "zustand";
import { vmSingleton } from "../singleton.js";
import { getWorkflow } from "../ai/workflows.js";
import { getActiveProvider } from "../ai/providers/index.js";
import { addContext, contextKey } from "../ai/context.js";
import { useAiPrefs } from "../aiPrefs.js";
import { useProjectStore } from "./projectStore.js";

const WORKFLOW_ID = "ask";
const STORAGE_KEY = "engine.ai.history.v1";
const MAX_CONVERSATIONS = 30;

let nextId = 1;
const makeId = () => `c${Date.now().toString(36)}${nextId++}`;

/** A fresh, empty conversation. */
function newConversation() {
  return {
    id: makeId(),
    title: null, // derived from the first message; null until there is one
    messages: [], // { role, text, lines: [], meta: {}, contexts?, error?, cancelled? }
    contexts: [], // chips currently attached to the NEXT message
    sessionId: null, // the provider's own thread id, so turn N+1 resumes turn N
    updatedAt: Date.now(),
  };
}

function load() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!Array.isArray(parsed) || !parsed.length) return null;
    return parsed
      .filter((c) => c && typeof c.id === "string" && Array.isArray(c.messages))
      .map((c) => ({
        ...newConversation(),
        ...c,
        // Trails are dropped on save; rebuild the field so nothing downstream
        // has to cope with a missing array on a restored message.
        messages: c.messages.map((m) => ({ lines: [], meta: {}, ...m })),
      }))
      .slice(0, MAX_CONVERSATIONS);
  } catch {
    return null;
  }
}

const restored = typeof localStorage === "undefined" ? null : load();
const initial = restored?.length ? restored : [newConversation()];

export const useAiStore = vmSingleton("aiStore", () =>
  create(() => ({
    status: "idle", // "idle" | "running" | "error"
    error: null,
    provider: null, // active provider's label, so the panel can show who answered
    model: null,
    conversations: initial,
    activeId: initial[0].id,
  })),
);

/** The active conversation, or the first one if the id ever goes stale. */
export function activeConversation(state = useAiStore.getState()) {
  return state.conversations.find((c) => c.id === state.activeId) ?? state.conversations[0];
}

/** Applies `fn` to the active conversation and writes it back. */
function patchActive(fn) {
  useAiStore.setState((s) => {
    const i = s.conversations.findIndex((c) => c.id === s.activeId);
    if (i < 0) return {};
    const next = [...s.conversations];
    next[i] = { ...fn(next[i]), updatedAt: Date.now() };
    return { conversations: next };
  });
  persist();
}

let persistTimer = null;
function persist() {
  // Debounced: a streaming turn patches the active conversation on every
  // event, and serializing the whole history that often would put a JSON
  // encode of every past chat on the frame budget of a live stream.
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      const slim = useAiStore
        .getState()
        .conversations.filter((c) => c.messages.length)
        .slice(0, MAX_CONVERSATIONS)
        .map((c) => ({
          ...c,
          messages: c.messages.map(({ lines, ...rest }) => rest), // trails are progress, not content
        }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
    } catch {
      // Non-fatal: history just won't survive a restart (quota, private mode).
    }
  }, 400);
}

/** Replaces the last message, which is always the assistant turn being streamed. */
function patchLastMessage(fn) {
  patchActive((c) => {
    const last = c.messages[c.messages.length - 1];
    if (!last || last.role !== "assistant") return c;
    return { ...c, messages: [...c.messages.slice(0, -1), fn(last)] };
  });
}

/**
 * Applies one `{lines, result, meta}` event to the in-flight assistant turn.
 * Every provider emits this exact shape — `claudeCli.js` converts its raw
 * `stream-json` lines through `parseStreamEvent` before calling `onEvent`, and
 * the tool-loop providers produce it directly — so this is the one place that
 * knows how to render a turn regardless of which provider is behind it.
 *
 * `meta` is a PARTIAL patch, merged rather than assigned: the model arrives on
 * the first event and the cost on the last, and assigning would erase one with
 * the other's nulls.
 */
function handleEvent({ lines, result, meta }) {
  if (lines?.length || result != null || meta) {
    patchLastMessage((m) => ({
      ...m,
      lines: lines?.length ? [...m.lines, ...lines] : m.lines,
      text: result != null ? result : m.text,
      meta: meta ? { ...m.meta, ...meta } : m.meta,
    }));
  }
  // The session id belongs to the CONVERSATION, not to one turn — the next
  // send resumes it. The model is shown once in the header rather than per
  // bubble, so it lives at the top level.
  if (meta?.sessionId) patchActive((c) => ({ ...c, sessionId: meta.sessionId }));
  if (meta?.model) useAiStore.setState({ model: meta.model });
}

// ---- context chips ---------------------------------------------------------

/** Replaces the chip row outright (what a context-menu "Ask AI" does). */
export function setAiContexts(contexts) {
  patchActive((c) => ({ ...c, contexts: (contexts ?? []).filter(Boolean) }));
}

/** Adds one chip, replacing any chip already naming the same thing. */
export function addAiContext(context) {
  if (!context) return;
  patchActive((c) => ({ ...c, contexts: addContext(c.contexts, context) }));
}

export function removeAiContext(context) {
  const key = contextKey(context);
  patchActive((c) => ({ ...c, contexts: c.contexts.filter((x) => contextKey(x) !== key) }));
}

// ---- conversations ---------------------------------------------------------

/**
 * Starts a new conversation, carrying the current chips over — you almost
 * always want a clean thread about the SAME thing, and re-dragging the entity
 * you were just discussing is pure friction.
 */
export function newChat() {
  if (useAiStore.getState().status === "running") return;
  const carried = activeConversation()?.contexts ?? [];
  const fresh = { ...newConversation(), contexts: carried };
  useAiStore.setState((s) => ({
    // An untouched empty conversation is not worth keeping around when the
    // user asks for another one; it would just stack blank rows in History.
    conversations: [fresh, ...s.conversations.filter((c) => c.messages.length)].slice(0, MAX_CONVERSATIONS),
    activeId: fresh.id,
    status: "idle",
    error: null,
  }));
  persist();
}

export function selectChat(id) {
  if (useAiStore.getState().status === "running") return;
  if (!useAiStore.getState().conversations.some((c) => c.id === id)) return;
  useAiStore.setState({ activeId: id, status: "idle", error: null });
}

export function deleteChat(id) {
  useAiStore.setState((s) => {
    const remaining = s.conversations.filter((c) => c.id !== id);
    const conversations = remaining.length ? remaining : [newConversation()];
    return {
      conversations,
      activeId: s.activeId === id ? conversations[0].id : s.activeId,
    };
  });
  persist();
}

// ---- running a turn --------------------------------------------------------

/**
 * Sends one message and streams the reply into the active transcript.
 *
 * Returns without doing anything if a turn is already in flight — the composer
 * disables its send button for the same reason, but nothing stops a keyboard
 * shortcut or a future call site from racing it.
 */
export async function sendMessage(text) {
  const body = String(text ?? "").trim();
  if (!body) return;

  const state = useAiStore.getState();
  if (state.status === "running") return;
  const conversation = activeConversation(state);
  if (!conversation) return;

  const workflow = getWorkflow(WORKFLOW_ID);
  if (!workflow) throw new Error(`Unknown AI workflow "${WORKFLOW_ID}"`);

  const provider = getActiveProvider();
  if (!provider) {
    useAiStore.setState({ status: "error", error: "No AI provider configured. Pick one in the AI provider settings." });
    return;
  }

  // The unattended-mutating-run rule, enforced here rather than only in the
  // menu items that offer this action. `interactive` is what exempts `ask`:
  // the gap this guard exists to close is a ONE-CLICK menu item quietly
  // changing the project on a provider that cannot limit its own tools. A
  // conversation the user typed into and is watching stream is the same trust
  // posture as the Terminal panel, which already ships a fully-permissioned
  // session — refusing it here would only make the feature useless on the
  // default provider without making anything safer.
  if (workflow.mutates && !workflow.interactive && !provider.capabilities.scopedTools) {
    useAiStore.setState({
      status: "error",
      provider: provider.label,
      error: `"${workflow.label}" can change the scene, and ${provider.label} cannot limit itself to this workflow's tools. Switch to a scoped provider (e.g. Ollama) to run it.`,
    });
    return;
  }

  // History for the providers that have none of their own: `toolLoop.js` is
  // stateless per call, so the store's own transcript IS its memory. The
  // claudeCli provider ignores this and resumes `sessionId` instead — its
  // history lives in the CLI's session file, which also keeps the tool
  // results out of a prompt we'd otherwise have to re-send every turn.
  const history = conversation.messages
    .filter((m) => typeof m.text === "string" && m.text.trim())
    .map((m) => ({ role: m.role, content: m.text }));

  const contexts = conversation.contexts;
  const prompt = workflow.buildPrompt({ text: body, contexts });
  const prefs = useAiPrefs.getState();

  patchActive((c) => ({
    ...c,
    // The first message names the thread in the History list. Trimmed here
    // rather than at render time so a restored conversation keeps its title
    // even if the message list is later trimmed.
    title: c.title ?? body.slice(0, 60),
    messages: [
      ...c.messages,
      // The chips are recorded ON the user message, not just on the
      // conversation: they can change between turns, and a transcript that
      // showed the CURRENT chips against an old question would misreport what
      // was actually asked.
      { role: "user", text: body, contexts, lines: [], meta: {} },
      { role: "assistant", text: null, lines: [], meta: {} },
    ],
  }));
  useAiStore.setState({ status: "running", error: null, provider: provider.label });

  try {
    await provider.runTurn(
      {
        workflow,
        prompt,
        history,
        contexts,
        sessionId: conversation.sessionId,
        systemPrompt: workflow.systemPrompt,
        model: prefs.claudeModel || null,
        effort: prefs.claudeEffort || null,
        cwd: useProjectStore.getState().rootPath ?? null,
      },
      handleEvent,
    );
    if (useAiStore.getState().status === "running") useAiStore.setState({ status: "idle" });
  } catch (err) {
    const message = String(err?.message ?? err);
    if (useAiStore.getState().status === "running") {
      patchLastMessage((m) => ({ ...m, error: message }));
      useAiStore.setState({ status: "error", error: message });
    }
  }
  persist();
}

/**
 * Cancels the in-flight turn. The half-finished assistant bubble stays in the
 * transcript, marked — deleting it would hide what the assistant had already
 * done to the project before you stopped it, which is the one thing you most
 * need to see after hitting stop.
 */
export async function cancelRun() {
  if (useAiStore.getState().status !== "running") return;
  patchLastMessage((m) => ({ ...m, cancelled: true }));
  useAiStore.setState({ status: "idle" });
  await getActiveProvider()?.cancelTurn();
}
