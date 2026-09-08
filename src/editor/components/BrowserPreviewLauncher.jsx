import { useEffect, useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import { Link2, Loader2, Monitor, QrCode, Share2, Smartphone, Wifi } from "../icons/index.jsx";
import {
  getBrowserPreviewState,
  onBrowserPreviewChanged,
  openBrowserPreviewUrl,
  setBrowserPreviewMessage,
  toggleBrowserPreview,
  toggleShareTunnel,
} from "../browserPreview.js";
import { useProjectStore } from "../store/projectStore.js";
import { usePlayStore } from "../store/playStore.js";

/**
 * The browser-preview button and its fly-out of endpoints (Wi-Fi HTTPS,
 * localhost, a public share link, a QR code).
 *
 * Lived in the viewport toolbar until the transport moved to the top bar
 * (docs/EDITOR_UI_PLAN.md stage 2); previewing the game is an application
 * verb like Play and Build, so it travels with them. Mirrored from
 * browserPreview.js rather than owned here: the server outlives any panel
 * and can be started by things that are not this button — the boot
 * autostart, an agent — and subscribing is what makes those visible.
 */
export function BrowserPreviewLauncher() {
  const rootPath = useProjectStore((s) => s.rootPath);
  const playing = usePlayStore((s) => s.playing);
  const [browserPreview, setBrowserPreview] = useState(getBrowserPreviewState);
  useEffect(() => onBrowserPreviewChanged(setBrowserPreview), []);
  // Separate from `busy`: only the share endpoint should spin while a tunnel
  // starts, not while the preview itself builds.
  const shareBusy = browserPreview.sharing;
  // The public link wins the QR slot when it exists: it works from any phone
  // with no certificate warning, which is what a scanned code is for.
  const qrUrl = browserPreview.share?.url || browserPreview.urls?.lanUrl || "";
  const qrImage = useMemo(() => {
    if (!qrUrl) return "";
    const qr = qrcode(0, "M");
    qr.addData(qrUrl);
    qr.make();
    const svg = qr.createSvgTag({ cellSize: 3, margin: 2, scalable: true });
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }, [qrUrl]);

  const openEndpoint = async (url) => {
    try {
      await openBrowserPreviewUrl(url);
    } catch (error) {
      console.error(`Could not open preview URL ${url}: ${error?.message ?? error}`);
      navigator.clipboard?.writeText(url).catch(() => {});
      setBrowserPreviewMessage(`Could not open URL; copied to clipboard: ${url}`);
    }
  };
  const keyOpens = (url) => (event) => {
    if (event.key === "Enter" || event.key === " ") openEndpoint(url);
  };

  return (
    <div className={`browser-preview-launcher ${browserPreview.urls ? "is-active" : ""} ${shareBusy ? "is-sharing" : ""}`}>
      <button
        className={`toolbar-btn icon-only ${browserPreview.urls ? "active" : ""}`}
        disabled={!rootPath || browserPreview.busy}
        title={
          browserPreview.urls
            ? "Stop browser preview server (this project stops serving on startup too)"
            : browserPreview.message ||
              (playing
                ? "Stop Play mode, then build and serve it"
                : "Build and serve on localhost and local Wi-Fi over HTTPS — stays on across editor restarts")
        }
        onClick={() => toggleBrowserPreview()}
      >
        <Wifi size={13} />
      </button>
      {browserPreview.urls && (
        <div className="browser-preview-endpoints" aria-label="Browser preview links">
          {browserPreview.urls.lanUrl && (
            <span
              className="browser-preview-endpoint"
              role="button"
              tabIndex={0}
              title={`Open Wi-Fi HTTPS preview (phones/tablets)\n${browserPreview.urls.lanUrl}\nAccept the local certificate once on this device.`}
              onClick={() => openEndpoint(browserPreview.urls.lanUrl)}
              onKeyDown={keyOpens(browserPreview.urls.lanUrl)}
            >
              <Smartphone size={13} />
            </span>
          )}
          {browserPreview.urls.localUrl && (
            <span
              className="browser-preview-endpoint"
              role="button"
              tabIndex={0}
              title={`Open localhost\n${browserPreview.urls.localUrl}`}
              onClick={() => openEndpoint(browserPreview.urls.localUrl)}
              onKeyDown={keyOpens(browserPreview.urls.localUrl)}
            >
              <Monitor size={13} />
            </span>
          )}
          <span
            className={`browser-preview-endpoint ${browserPreview.share ? "active" : ""}`}
            role="button"
            tabIndex={0}
            title={
              shareBusy
                ? browserPreview.message || "Creating public link…"
                : browserPreview.share
                  ? `Stop public share link\n${browserPreview.share.url}`
                  : "Create a public share link anyone can open (Cloudflare quick tunnel)"
            }
            aria-label={browserPreview.share ? "Stop public share link" : "Create public share link"}
            onClick={toggleShareTunnel}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") toggleShareTunnel();
            }}
          >
            {shareBusy ? <Loader2 size={13} className="endpoint-spin" /> : <Share2 size={13} />}
          </span>
          {browserPreview.share && (
            <span
              className="browser-preview-endpoint"
              role="button"
              tabIndex={0}
              title={`Open public link (click also copies it)\n${browserPreview.share.url}`}
              onClick={() => {
                navigator.clipboard?.writeText(browserPreview.share.url).catch(() => {});
                openEndpoint(browserPreview.share.url);
              }}
              onKeyDown={keyOpens(browserPreview.share.url)}
            >
              <Link2 size={13} />
            </span>
          )}
          {qrImage && (
            <span
              className="browser-preview-endpoint browser-preview-qr"
              tabIndex={0}
              title={browserPreview.share ? "Show public link QR code" : "Show Wi-Fi QR code"}
              aria-label="Show preview QR code"
            >
              <QrCode size={13} />
              <span className="browser-preview-qr-popover">
                <img src={qrImage} alt={`QR code for ${qrUrl}`} />
              </span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
