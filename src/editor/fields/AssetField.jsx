import { isBuiltinMaterial } from "../../engine/builtinMaterials.js";
import { useCallback, useRef, useState } from "react";
import { ChevronDown } from "../icons/index.jsx";
import { useAssetDrop } from "../assetDrag.js";
import { revealAssetInPanel } from "../assetReveal.js";
import { AssetPeek } from "../components/AssetThumb.jsx";
import { thumbKind } from "../assetThumbs.js";
import { ContextMenu, useContextMenu } from "../ContextMenu.jsx";
import { openAssetPath } from "../openAsset.js";
import { openPanel } from "../EditorShell.jsx";
import { useSelectionStore } from "../store/selectionStore.js";
import { AssetBrowser, AssetPicture } from "./AssetBrowser.jsx";

const fileName = (p) => p?.split(/[\\/]/).pop() ?? "";

/**
 * The kinds you choose by looking at them. A field for one of these is a
 * CARD — the preview is most of it, the name and the caret sit under it —
 * and its picker is a grid of previews. Everything else (a script, a sound)
 * is a row: glyph, name, caret.
 */
const CARD_EXTS = new Set([
  "geom",
  "mat",
  "hdr",
  "exr",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "scene",
  "cubemap",
  "glb",
  "gltf",
  "fbx",
  "prefab",
]);
const isCardExt = (ext) => CARD_EXTS.has(String(ext).toLowerCase());

/**
 * Asset reference input: a drop target for a tile dragged out of the Assets
 * panel, and a click opens the browser (`AssetBrowser`) over every project
 * file of the right type (`descriptor.exts`). Never a text box. The value is
 * the asset's absolute path; commit "" to clear.
 *
 * `descriptor.compact` (or `thumbSize="compact"`) keeps a row for a kind that
 * would otherwise get a card — a dense list of slots, say.
 */
export function AssetField({ descriptor, value, onCommit, thumbSize = "small" }) {
  const [open, setOpen] = useState(false);
  // The hover peek on a row: which asset, and the rect it floats beside.
  const [peek, setPeek] = useState(null);
  const triggerRef = useRef(null);

  const exts = descriptor.exts ?? [];
  const emptyLabel = descriptor.emptyLabel ?? "None";
  const hasThumb = !!value && !!thumbKind(value);
  const card = !descriptor.compact && thumbSize !== "compact" && (exts.some(isCardExt) || hasThumb);

  const dropRef = useAssetDrop({ accepts: exts, onDrop: onCommit });
  // One element is both the drop target and the browser's anchor.
  const setTriggerRef = useCallback(
    (el) => {
      triggerRef.current = el;
      dropRef(el);
    },
    [dropRef],
  );

  const browse = () => {
    // Clicking a filled slot also points the Assets panel at the file, so
    // "which material is this?" is answered without leaving the inspector.
    if (value && !isBuiltinMaterial(value)) revealAssetInPanel(value).catch(() => {});
    setPeek(null);
    setOpen(true);
  };
  const onKey = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      browse();
    }
  };

  // Left-click is the picker; everything that acts on the asset ALREADY in
  // the slot lives in the context menu.
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();
  const menuItems = value
    ? [
        {
          label: "Show in Assets Panel",
          action: async () => {
            openPanel("assets");
            // Let Dockview mount/activate the panel before it is asked to
            // browse; revealing into a panel that doesn't exist yet is a no-op.
            await new Promise((resolve) => requestAnimationFrame(resolve));
            revealAssetInPanel(value).catch(() => {});
          },
        },
        { label: "Open", action: () => openAssetPath(value) },
        {
          label: "Select Asset",
          hint: "Show this asset's own import settings in the Inspector",
          action: () => useSelectionStore.getState().selectAsset(value),
        },
        { separator: true },
        { label: "Copy Path", action: () => navigator.clipboard.writeText(value).catch(() => {}) },
        { label: "Replace…", action: browse },
        { label: "Clear", danger: true, action: () => onCommit("") },
      ]
    : [{ label: "Browse…", action: browse }];
  const visibleMenu = isBuiltinMaterial(value)
    ? menuItems.filter((item) => !["Show in Assets Panel", "Select Asset"].includes(item.label))
    : menuItems;

  const name = value ? (isBuiltinMaterial(value) ? "Water" : fileName(value)) : emptyLabel;
  const title = value || `${emptyLabel} — drop an asset here or pick one`;

  return (
    <div className={`dropdown-wrap asset-field-wrap${card ? " card" : ""}`}>
      {card ? (
        <div
          ref={setTriggerRef}
          className={`asset-card${value ? "" : " empty"} kind-${(value && thumbKind(value)) || "none"}`}
          role="button"
          tabIndex={0}
          title={title}
          onClick={browse}
          onKeyDown={onKey}
          onContextMenu={openMenu}
        >
          <div className="asset-card-preview">
            {value ? <AssetPicture path={value} glyphSize={32} /> : <span className="asset-card-none">{emptyLabel}</span>}
          </div>
          <div className="asset-card-foot">
            <span className="asset-card-name">{name}</span>
            <ChevronDown size={12} className="asset-card-caret" aria-hidden="true" />
          </div>
        </div>
      ) : (
        <div
          ref={setTriggerRef}
          className={`asset-field${value ? "" : " empty"}`}
          role="button"
          tabIndex={0}
          title={title}
          onClick={browse}
          onKeyDown={onKey}
          onContextMenu={openMenu}
          onPointerEnter={hasThumb ? (e) => setPeek({ path: value, rect: e.currentTarget.getBoundingClientRect() }) : undefined}
          onPointerLeave={() => setPeek(null)}
        >
          {value && (
            <span className="asset-field-thumb">
              <AssetPicture path={value} glyphSize={13} />
            </span>
          )}
          <span className="asset-field-name">{name}</span>
          <span className="asset-field-caret" aria-hidden="true">
            <ChevronDown size={12} />
          </span>
        </div>
      )}
      {open && (
        <AssetBrowser
          anchorRef={triggerRef}
          exts={exts}
          value={value}
          emptyLabel={emptyLabel}
          layer={descriptor.layer}
          onPick={(path) => {
            setOpen(false);
            onCommit(path);
          }}
          onClose={() => setOpen(false)}
        />
      )}
      {peek && <AssetPeek path={peek.path} rect={peek.rect} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={visibleMenu} onClose={closeMenu} />}
    </div>
  );
}
