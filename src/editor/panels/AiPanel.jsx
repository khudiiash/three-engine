import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ChevronRight, Camera, History, Paperclip, Plus, Sparkles, Square, Trash2, X } from "../icons/index.jsx";
import {
  useAiStore,
  activeConversation,
  sendMessage,
  cancelRun,
  newChat,
  selectChat,
  deleteChat,
  addAiContext,
  removeAiContext,
} from "../store/aiStore.js";
import { useAiPrefs, setAiPrefs, CLAUDE_MODELS, CLAUDE_EFFORTS } from "../aiPrefs.js";
import { entityContext, assetContext, fileContext, viewportContext, sceneContext, contextKey } from "../ai/context.js";
import { useEntityDrop } from "../entityDrag.js";
import { useAssetDrop } from "../assetDrag.js";
import { useSceneStore } from "../store/sceneStore.js";
import { PopoverMenu } from "../fields/PopoverMenu.jsx";

/**
 * The AI conversation.
 *
 * This replaced a read-only status board for a run you could only watch. The
 * old shape was the feature's real problem: the assistant had the whole editor
 * API and knew what you had right-clicked, and the one thing it was missing was
 * what you actually wanted — which a fixed "diagnose this" prompt could never
 * supply. So: a transcript, a text box, and a row of context chips naming what
 * the next message is about.
 *
 * Things a chat window here has to get right that a log did not:
 *
 *  - The tool calls are PROGRESS, not content, and they stay OUT OF SIGHT.
 *    `ToolTrail` shows one quiet line — what it is doing now, or how many
 *    calls it took — with the detail one click away. Streaming raw calls,
 *    arguments and results into the transcript buried the answer under a wall
 *    of escaped JSON; see that component's own note.
 *  - The composer must not steal editor keystrokes. The viewport's shortcuts
 *    are single letters (F, W, E, R); a focused textarea that let those bubble
 *    would focus-frame the scene every time you typed "focus".
 *  - Dragging things in has to go through `entityDrag.js`/`assetDrag.js`, NOT
 *    HTML5 drag-and-drop: Tauri's `dragDropEnabled` (which the Assets panel
 *    needs for OS file imports) swallows the webview's native DnD wholesale,
 *    so `dragover`/`drop` never fire here. Both those modules are pointer
 *    gestures with `elementFromPoint` hit-testing for exactly that reason.
 */

function formatTokens(n) {
  if (!n) return null;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k tokens` : `${n} tokens`;
}

function formatCost(usd) {
  if (usd == null) return null;
  return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

function formatDuration(ms) {
  if (ms == null) return null;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Just the tool's name, without the argument hint `summarizeCall` appended. */
function toolNameOf(line) {
  return (line.text ?? "").split(" ")[0] || null;
}

/**
 * The tool calls behind one assistant turn — ONE quiet line, closed.
 *
 * This used to spring open while the turn ran and stream every call and every
 * result into the transcript. In practice that buried the answer under a wall
 * of escaped JSON: raw MCP tool names, full argument objects, `Bash` command
 * lines with absolute paths, and 120 kB tool results clipped mid-string. The
 * user's verdict was blunt — don't show the internal thinking and the commands
 * running.
 *
 * So the default is a single line that names what it is doing right now
 * ("Working · entity.get") and, when finished, how much it took ("6 tool
 * calls"). The detail is still one click away, because when something goes
 * wrong it is exactly what you need — it is just no longer the default view of
 * a working assistant. Expanded state is per-turn and local: the transcript is
 * the store's business, "did I open this disclosure" is not.
 */
function ToolTrail({ lines, live }) {
  const [open, setOpen] = useState(false);
  const trail = useMemo(() => lines.filter((l) => l.kind !== "text"), [lines]);
  if (!trail.length) return null;

  const calls = trail.filter((l) => l.kind === "tool_call");
  // What it is doing NOW, not everything it has done — a list that grows while
  // you read it is the thing that made the old header unreadable too.
  const current = live ? toolNameOf(calls[calls.length - 1] ?? {}) : null;
  const failed = trail.some((l) => l.kind === "tool_result");

  return (
    <div className={`ai-trail${open ? " open" : ""}${live ? " live" : ""}`}>
      <button className="ai-trail-head" onClick={() => setOpen((v) => !v)}>
        <ChevronRight size={11} className="ai-trail-caret" />
        <span>
          {live ? `Working${current ? ` · ${current}` : "…"}` : `${calls.length} tool call${calls.length === 1 ? "" : "s"}`}
          {!live && failed ? " · had an error" : ""}
        </span>
      </button>
      {open && (
        <div className="ai-trail-body">
          {trail.map((line, i) => (
            <div key={i} className={`ai-line ${line.kind}`}>
              {line.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** One context chip. `onRemove` omitted makes it a read-only transcript badge. */
function Chip({ context, onRemove }) {
  return (
    <span className="ai-chip" title={context.refs.join("\n") || context.kind}>
      <span className="ai-chip-kind">{context.kind}</span>
      <span className="ai-chip-label">{context.label}</span>
      {onRemove && (
        <button className="ai-chip-x" title="Remove" onClick={() => onRemove(context)}>
          <X size={10} />
        </button>
      )}
    </span>
  );
}

function Message({ message, live }) {
  if (message.role === "user") {
    return (
      <div className="ai-msg user">
        <div className="ai-bubble">
          {message.contexts?.length > 0 && (
            <div className="ai-bubble-chips">
              {message.contexts.map((c) => (
                <Chip key={contextKey(c)} context={c} />
              ))}
            </div>
          )}
          {message.text}
        </div>
      </div>
    );
  }

  // While a turn streams, the assistant's prose arrives as `text` LINES; the
  // final `result` event then repeats the whole thing. Rendering both is what
  // printed every answer twice in the old panel — prefer the result once it
  // exists, and fall back to the streamed pieces until then, which is what
  // makes the answer appear as it's written rather than all at once at the end.
  const streamed = message.lines.filter((l) => l.kind === "text").map((l) => l.text).join("\n\n");
  const body = message.text ?? streamed;
  const meta = message.meta ?? {};
  const footer = [formatDuration(meta.durationMs), formatTokens(meta.tokens), formatCost(meta.costUsd)]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="ai-msg assistant">
      <ToolTrail lines={message.lines} live={live} />
      {body && <div className="ai-answer">{body}</div>}
      {live && !body && message.lines.length === 0 && <div className="ai-thinking">Thinking…</div>}
      {message.cancelled && <div className="ai-note">Stopped. Anything it already changed is on the undo stack.</div>}
      {message.error && <div className="ai-line error">{message.error}</div>}
      {footer && <div className="ai-msg-meta">{footer}</div>}
    </div>
  );
}

/** Past conversations, newest first. */
function HistoryMenu({ anchorRef, onClose }) {
  const conversations = useAiStore((s) => s.conversations);
  const activeId = useAiStore((s) => s.activeId);
  const rows = useMemo(
    () => [...conversations].filter((c) => c.messages.length).sort((a, b) => b.updatedAt - a.updatedAt),
    [conversations],
  );

  return (
    <PopoverMenu anchorRef={anchorRef} className="component-menu ai-history" minWidth={240} onClose={onClose}>
      <div className="component-menu-list">
        {rows.length === 0 && <div className="dropdown-item">No past chats</div>}
        {rows.map((c) => (
          <div key={c.id} className={`dropdown-item ai-history-row${c.id === activeId ? " checked" : ""}`}>
            <button
              className="ai-history-pick"
              title={c.title ?? "Untitled"}
              onClick={() => {
                selectChat(c.id);
                onClose();
              }}
            >
              <span className="ai-history-title">{c.title ?? "Untitled"}</span>
              <span className="ai-history-count">{c.messages.filter((m) => m.role === "user").length}</span>
            </button>
            <button className="ai-history-del" title="Delete this chat" onClick={() => deleteChat(c.id)}>
              <Trash2 size={11} />
            </button>
          </div>
        ))}
      </div>
    </PopoverMenu>
  );
}

export function AiPanel() {
  const status = useAiStore((s) => s.status);
  const error = useAiStore((s) => s.error);
  const model = useAiStore((s) => s.model);
  const provider = useAiStore((s) => s.provider);
  const conversation = useAiStore(activeConversation);
  const entities = useSceneStore((s) => s.entities);
  const prefs = useAiPrefs();

  const messages = conversation?.messages ?? [];
  const contexts = conversation?.contexts ?? [];

  const [draft, setDraft] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const historyBtnRef = useRef(null);
  const running = status === "running";

  // Follow the tail only when the user is already there. Yanking the view back
  // down while they are reading an earlier answer is the single most
  // infuriating thing a streaming transcript can do.
  const pinnedRef = useRef(true);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  });

  // Focus the composer when the panel appears and whenever the thread changes —
  // "Ask AI" should land you at a blinking cursor, not a box you have to click.
  useEffect(() => {
    inputRef.current?.focus();
  }, [conversation?.id]);

  // Dropping an entity from the Hierarchy, or an asset from the browser,
  // ATTACHES it rather than replacing what is there: "why does this material
  // look wrong on that mesh" is a two-chip question, and a drop that wiped the
  // first chip could never express it.
  const entityDropRef = useEntityDrop({
    onDrop: (ids) => {
      const label = ids.length === 1 ? (entities?.[ids[0]]?.name ?? ids[0]) : `${ids.length} entities`;
      addAiContext(entityContext(ids, label));
      inputRef.current?.focus();
    },
  });
  const assetDropRef = useAssetDrop({
    hoverClass: "ai-drop-hover",
    onDrop: (path) => {
      addAiContext(assetContext([path]));
      inputRef.current?.focus();
    },
  });
  // One element, two drag systems — they are separate registries (entities and
  // asset paths travel differently), so the ref has to feed both.
  const dropRef = useCallback(
    (el) => {
      entityDropRef(el);
      assetDropRef(el);
    },
    [entityDropRef, assetDropRef],
  );

  const attachFiles = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ multiple: true, title: "Attach files for the assistant" });
      const paths = (Array.isArray(picked) ? picked : picked ? [picked] : []).filter(Boolean);
      if (paths.length) addAiContext(fileContext(paths));
    } catch (err) {
      console.error(`Could not attach files: ${err?.message ?? err}`);
    }
    inputRef.current?.focus();
  };

  const subtitle = [provider, model].filter(Boolean).join(" · ");

  const send = () => {
    const text = draft.trim();
    if (!text || running) return;
    setDraft("");
    pinnedRef.current = true;
    sendMessage(text);
  };

  const onKeyDown = (event) => {
    // Every key typed here belongs to the textarea, never to the viewport's
    // single-letter shortcuts (F focus, W/E/R gizmos) — see the module doc.
    event.stopPropagation();
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  return (
    <div className="inspector-panel ai-panel" ref={dropRef}>
      <div className="ai-bar">
        <button className="ai-bar-btn" title="New chat" disabled={running} onClick={() => newChat()}>
          <Plus size={13} />
        </button>
        <button ref={historyBtnRef} className="ai-bar-btn" title="Past chats" onClick={() => setHistoryOpen(true)}>
          <History size={13} />
        </button>
        {historyOpen && <HistoryMenu anchorRef={historyBtnRef} onClose={() => setHistoryOpen(false)} />}

        <select
          className="ai-bar-select"
          title="Model — Default leaves the CLI's own setting alone"
          value={prefs.claudeModel}
          onChange={(e) => setAiPrefs({ claudeModel: e.target.value })}
        >
          {CLAUDE_MODELS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <select
          className="ai-bar-select"
          title="Effort — how hard the model works before answering"
          value={prefs.claudeEffort}
          onChange={(e) => setAiPrefs({ claudeEffort: e.target.value })}
        >
          {CLAUDE_EFFORTS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>

        <span className="ai-bar-sub">{subtitle}</span>
      </div>

      <div
        className="ai-log"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {messages.length === 0 ? (
          <div className="ai-empty">
            <Sparkles size={14} />
            <p>Ask about the scene, an entity, an asset — anything in this project.</p>
            <p className="ai-empty-sub">
              Drag entities or assets in to attach them. It can read and change the editor through the same API the
              MCP tools use; edits go through undo.
            </p>
          </div>
        ) : (
          messages.map((message, i) => (
            <Message key={i} message={message} live={running && i === messages.length - 1} />
          ))
        )}
        {error && status === "error" && <div className="ai-line error">{error}</div>}
      </div>

      <div className="ai-attach-row">
        {contexts.map((c) => (
          <Chip key={contextKey(c)} context={c} onRemove={removeAiContext} />
        ))}
        <button className="ai-attach-btn" title="Attach files" onClick={attachFiles}>
          <Paperclip size={12} />
        </button>
        <button
          className="ai-attach-btn"
          title="Let the assistant look at the viewport"
          onClick={() => addAiContext(viewportContext())}
        >
          <Camera size={12} />
        </button>
        <button className="ai-attach-btn wide" title="Ask about the whole scene" onClick={() => addAiContext(sceneContext())}>
          Scene
        </button>
      </div>

      <div className="ai-composer">
        <textarea
          ref={inputRef}
          className="ai-input"
          rows={2}
          placeholder={contexts.length ? `Ask about ${contexts.map((c) => c.label).join(", ")}…` : "Ask anything…"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {running ? (
          <button className="ai-send stop" title="Stop" onClick={() => cancelRun()}>
            <Square size={12} />
          </button>
        ) : (
          <button className="ai-send" title="Send (Enter)" disabled={!draft.trim()} onClick={send}>
            <ArrowUp size={13} />
          </button>
        )}
      </div>
    </div>
  );
}
