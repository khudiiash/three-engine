import { engine } from "./engineInstance.js";
import { readLiveCanvasImage, imageDataToDataUrl } from "../engine/renderTargetImage.js";
import { getProjectSettings } from "./projectSettings.js";
import { joinPath } from "./assetOps.js";
import { writeBinaryFile } from "./assetLoader.js";
import { pushToast } from "./toasts.js";

/**
 * The Shift+Alt+S viewport screenshot: the frame exactly as it is on the
 * canvas, written straight to disk — no save dialog, because the point of the
 * chord is that it is instant. Where it lands and what it is called come from
 * Project Settings → Screenshot (folder + filename prefix); an empty folder
 * means the OS Downloads folder under Tauri. The saved file's path is put on
 * the clipboard, so the shot can be pasted as a link straight away.
 *
 * ## The capture reads the live canvas, it does not re-render
 *
 * Re-rendering the scene into an offscreen target (what the `viewport.screenshot`
 * op does) cannot see content that is blitted onto the canvas AFTER the main
 * draw — the GI path-tracer debug view is exactly such a post-render blit, and
 * a re-rendered screenshot of a scene showing it comes back without it. So
 * this module hooks `engine.onPostRender`, registered LAST so it runs after
 * every other overlay has drawn, and copies the presented canvas through
 * `readLiveCanvasImage`. WYSIWYG is the contract: debug views, overlays,
 * whatever the frame actually was.
 *
 * Under a plain browser (the `vite dev` path, no Tauri shell) there is no
 * folder to write into, so the PNG goes through the browser's own download
 * flow instead. A failure of a USER-CONFIGURED folder is not degraded away —
 * that misconfiguration would otherwise look like "the screenshot never
 * happened".
 */

const TOAST_KEY = "viewport-screenshot";

/** True when a Tauri shell (real app or harness shim) owns the window. */
function inTauri() {
  return !!globalThis.__TAURI_INTERNALS__;
}

/**
 * One frame, as presented. Arms a one-shot post-render hook — the copy must
 * happen inside the frame's task, while the canvas texture is still current —
 * and resolves with the PNG.
 *
 * The loop may be fully STOPPED (the editor suspends it when idle — see
 * editorFramePacing's `host.stop()`), in which case the hook would never
 * fire; after a short grace the engine's loop is started for one frame, and
 * the next tick runs the whole chain — scene draw, path-tracer blit, this
 * hook. editorFramePacing re-suspends the loop on its own afterwards.
 */
function captureLiveCanvasDataUrl() {
  return new Promise((resolve, reject) => {
    const renderer = engine.renderer;
    if (!renderer) {
      reject(new Error("The renderer is not ready yet."));
      return;
    }
    let settled = false;
    const off = engine.onPostRender(async () => {
      off();
      settled = true;
      try {
        const { data, width, height } = await readLiveCanvasImage(renderer);
        resolve(imageDataToDataUrl(data, width, height));
      } catch (err) {
        reject(err);
      }
    });
    setTimeout(() => {
      if (!settled) engine.start?.();
    }, 400);
    setTimeout(() => {
      if (!settled) {
        off();
        reject(new Error("No frame rendered to capture — the viewport loop did not tick."));
      }
    }, 3000);
  });
}

/** `<prefix>-2026-09-04_14-32-05.png`. Second-resolution — the two captures
 *  a fast double-press produces are more than a second apart anyway, since
 *  each one waits for a full frame. */
function screenshotFileName(prefix) {
  const clean = String(prefix ?? "")
    .replace(/[\\/:*?"<>|]/g, "")
    .trim()
    .replace(/\.+$/, "");
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` +
    `_${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
  return `${clean || "screenshot"}-${stamp}.png`;
}

function pngBytesFromDataUrl(dataUrl) {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Puts `text` on the clipboard. Under Tauri the clipboard-manager plugin is
 * the reliable route — the webview's own async clipboard API is unevenly
 * implemented across platforms; a plain browser uses that API directly.
 * Throws are fine: the caller only annotates the toast, the file is on disk.
 */
async function copyTextToClipboard(text) {
  if (inTauri()) {
    try {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(text);
      return;
    } catch (err) {
      console.warn(`Clipboard plugin unavailable (${err?.message ?? err}) — trying the webview clipboard`);
    }
  }
  await navigator.clipboard.writeText(text);
}

/** Best-effort clipboard copy that only ever changes the toast wording. */
async function clipboardNote(text, label) {
  try {
    await copyTextToClipboard(text);
    return ` · ${label} copied to clipboard`;
  } catch (err) {
    console.warn(`Clipboard copy failed: ${err?.message ?? err}`);
    return " · clipboard copy failed";
  }
}

/** The browser-download route: the file lands wherever the browser's own
 *  download setting points, which is the best a plain webview can offer. */
function downloadViaAnchor(bytes, fileName) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Keep the URL alive past the download's start; there is no completion
  // event for an anchor download, so a generous fixed delay is the contract.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * Captures the viewport and saves it. Everything user-facing (the toast on
 * success, the toast on failure) happens here — the caller in EditorChrome
 * is a fire-and-forget dynamic import.
 */
export async function saveViewportScreenshot() {
  const shot = getProjectSettings().screenshot ?? {};
  let folder = shot.folder;
  try {
    const dataUrl = await captureLiveCanvasDataUrl();
    const bytes = pngBytesFromDataUrl(dataUrl);
    const fileName = screenshotFileName(shot.prefix);

    if (inTauri()) {
      try {
        if (!folder) {
          const { downloadDir } = await import("@tauri-apps/api/path");
          folder = await downloadDir();
        }
        const path = joinPath(folder, fileName);
        await writeBinaryFile(path, bytes);
        const note = await clipboardNote(path, "path");
        pushToast({ level: "info", title: "Screenshot saved", detail: `${path}${note}`, key: TOAST_KEY });
        return;
      } catch (err) {
        // A configured folder that failed is the user's answer being wrong —
        // surface it rather than quietly downloading somewhere else.
        if (folder) throw err;
        console.warn(`Screenshot save fell back to the browser download: ${err?.message ?? err}`);
      }
    }
    downloadViaAnchor(bytes, fileName);
    const note = await clipboardNote(fileName, "file name");
    pushToast({
      level: "info",
      title: "Screenshot downloaded",
      detail: `${fileName} — browser download folder${note}`,
      key: TOAST_KEY,
    });
  } catch (err) {
    pushToast({
      level: "error",
      title: "Screenshot failed",
      detail: String(err?.message ?? err),
      key: TOAST_KEY,
    });
  }
}
