import * as THREE from "three/webgpu";
import {
  ELEMENT_DEFAULTS,
  STRETCH_FILL_SPEC,
  computeElementRect,
  pivotPoint,
  intersectRects,
  rectContains,
  computeScreenScale,
  layoutChildren,
  clampScroll,
} from "./layout.js";

/**
 * Dedicated three.js layer for UI meshes. Scene cameras never enable it, so
 * UI quads (which live in the scene tree at pixel-scale coordinates) are
 * invisible to the 3D render; the UiSystem's own orthographic camera renders
 * *only* this layer in a post-render overlay pass.
 */
export const UI_LAYER = 30;

const CLICK_SLOP_PX = 5;

/**
 * Per-engine UI runtime. Created lazily by the first UiScreenComponent.
 *
 * Responsibilities:
 *  - Layout: every frame, walk each screen's entity subtree, compute element
 *    rects from anchors/layout containers/scroll offsets, write pixel-space
 *    positions into the entities' Object3Ds and push uniforms into visual
 *    components (image/text).
 *  - Render: post-render overlay pass with an orthographic camera
 *    (0..w, 0..-h — UI y-down maps to negative three.js y).
 *  - Input: pointer/wheel events on the renderer canvas → hover/press/click
 *    for buttons + scrolling, active only while the engine is playing.
 *  - Editor services: hitTest() for viewport picking and a selection
 *    highlight rect (editor-only, never active in exported games).
 */
export class UiSystem {
  constructor(engine) {
    this.engine = engine;
    this.screens = new Set(); // UiScreenComponent instances
    this.camera = new THREE.OrthographicCamera(0, 100, 0, -100, -1000, 1000);
    this.camera.layers.set(UI_LAYER);
    this.boundCanvas = null;
    this.pointer = { downButton: null, downX: 0, downY: 0, hover: null, scrollDrag: null };
    this.highlight = null; // { entityId } — editor selection outline
    this.highlightMesh = null;
    this.unsubUpdate = engine.onUpdate(() => this.update());
    this.unsubPost = engine.onPostRender(() => this.render());
    this.onPlayChanged = (playing) => {
      if (!playing) this.#clearInteraction();
    };
    engine.on("play-changed", this.onPlayChanged);
  }

  addScreen(screenComponent) {
    this.screens.add(screenComponent);
  }

  removeScreen(screenComponent) {
    this.screens.delete(screenComponent);
  }

  // -- Layout pass -----------------------------------------------------------

  update() {
    this.#bindInput();
    const renderer = this.engine.renderer;
    if (!renderer) return;
    const size = renderer.getSize(_v2);
    const dpr = renderer.getPixelRatio?.() ?? 1;
    for (const screen of this.screens) {
      this.#layoutScreen(screen, size.x, size.y, dpr);
    }
    this.#updateHighlight();
  }

  #layoutScreen(screen, canvasW, canvasH, dpr) {
    const entity = screen.entity;
    if (!entity) return;
    const p = screen.props;
    const s = computeScreenScale(p.scaleMode, p.referenceWidth, p.referenceHeight, canvasW, canvasH);
    const w = canvasW / s;
    const h = canvasH / s;
    // Everything the render + input passes need, cached on the component.
    screen.uiWidth = w;
    screen.uiHeight = h;
    screen.scale = s;
    screen.k = s * dpr; // UI px → physical framebuffer px
    screen.hitList = [];

    // The screen root is pinned to the world origin so the ortho camera's
    // 0..w/0..-h window lines up with it regardless of scene transforms.
    entity.object3D.position.set(0, 0, 0);
    entity.object3D.rotation.set(0, 0, 0);
    entity.object3D.scale.set(1, 1, 1);

    const screenRect = { x: 0, y: 0, w, h };
    const ctx = { k: screen.k, order: 1, screen, feather: 1 / Math.max(0.001, screen.k) };
    this.#layoutChildrenOf(entity, screenRect, { x: 0, y: 0 }, null, 1, ctx);
  }

  /** Recursively lays out `entity`'s children against `parentRect`. */
  #layoutChildrenOf(entity, parentRect, parentPivotAbs, clipRect, alpha, ctx) {
    // Scroll: children see a shifted parent rect and get clipped to it.
    const scroll = entity.getComponent?.("uiscroll");
    let childParentRect = parentRect;
    let childClip = clipRect;
    if (scroll) {
      scroll.scrollX = clampScroll(scroll.scrollX ?? 0, scroll.contentW ?? 0, parentRect.w);
      scroll.scrollY = clampScroll(scroll.scrollY ?? 0, scroll.contentH ?? 0, parentRect.h);
      childParentRect = {
        x: parentRect.x - scroll.scrollX,
        y: parentRect.y - scroll.scrollY,
        w: parentRect.w,
        h: parentRect.h,
      };
      childClip = intersectRects(clipRect, parentRect);
    }
    const mask = entity.getComponent?.("uimask");
    if (mask && mask.props.enabled !== false) {
      childClip = intersectRects(childClip, parentRect);
    }

    // Layout container: precompute rects for children, overriding anchors.
    const layout = entity.getComponent?.("uilayout");
    let layoutRects = null;
    if (layout) {
      const sizes = entity.children.map((child) => {
        const el = child.getComponent("uielement");
        return el ? [el.props.size[0] ?? 0, el.props.size[1] ?? 0] : [100, 100];
      });
      const result = layoutChildren(childParentRect, layout.props, sizes);
      layoutRects = result.rects;
      layout.contentMain = result.contentMain;
      if (layout.props.fitContent) {
        // Grow the container's own rect along the main axis so scroll views
        // (and hit testing) see the content extent.
        if (layout.props.direction === "row") childParentRect.w = Math.max(childParentRect.w, result.contentMain);
        else childParentRect.h = Math.max(childParentRect.h, result.contentMain);
      }
    }

    let maxX = childParentRect.x;
    let maxY = childParentRect.y;

    for (let i = 0; i < entity.children.length; i++) {
      const child = entity.children[i];
      const el = child.getComponent("uielement");
      const spec = el ? { ...ELEMENT_DEFAULTS, ...el.props } : STRETCH_FILL_SPEC;
      const rect = layoutRects ? layoutRects[i] : computeElementRect(childParentRect, spec);
      const pivotAbs = layoutRects
        ? { x: rect.x + spec.pivot[0] * rect.w, y: rect.y + spec.pivot[1] * rect.h }
        : pivotPoint(rect, spec);

      child.object3D.position.set(pivotAbs.x - parentPivotAbs.x, -(pivotAbs.y - parentPivotAbs.y), 0);
      const visible = el ? el.props.visible !== false : true;
      child.object3D.visible = visible;
      if (!visible) continue;

      const childAlpha = alpha * (el ? (el.props.opacity ?? 1) : 1);
      if (el) {
        el.rect = rect;
        el.clipRect = childClip ? { ...childClip } : null;
        el.worldAlpha = childAlpha;
        el.layoutControlled = !!layoutRects;
      }

      // Hit list in draw order (topmost last).
      ctx.screen.hitList.push({ entity: child, el, rect, clipRect: childClip });

      const frame = { rect, clipRect: childClip, alpha: childAlpha, k: ctx.k, feather: ctx.feather, order: ctx.order, spec };
      child.getComponent("uiimage")?.onUiLayout?.(frame);
      child.getComponent("uitext")?.onUiLayout?.(frame);
      ctx.order += 2; // image + text on the same entity stay ordered

      this.#layoutChildrenOf(child, rect, pivotAbs, childClip, childAlpha, ctx);
      // Content extent AFTER the recursion: a child's fitContent layout may
      // have grown its rect (the rect object is shared by reference), and
      // scroll views need to see the grown extent.
      maxX = Math.max(maxX, rect.x + rect.w);
      maxY = Math.max(maxY, rect.y + rect.h);
    }

    if (scroll) {
      scroll.contentW = maxX - childParentRect.x;
      scroll.contentH = maxY - childParentRect.y;
      scroll.viewportW = parentRect.w;
      scroll.viewportH = parentRect.h;
    }
  }

  // -- Render pass -----------------------------------------------------------

  render() {
    const renderer = this.engine.renderer;
    if (!renderer || !this.engine.rendererReady || this.screens.size === 0) return;

    const screens = [...this.screens]
      .filter((s) => s.entity && s.entity.object3D.visible !== false)
      .sort((a, b) => (a.props.sortOrder ?? 0) - (b.props.sortOrder ?? 0));
    if (screens.length === 0) return;

    const prevAutoClear = renderer.autoClear;
    const prevAutoClearColor = renderer.autoClearColor;
    const prevAutoClearDepth = renderer.autoClearDepth;
    renderer.autoClear = false;
    renderer.autoClearColor = false;
    renderer.autoClearDepth = false;
    try {
      for (const screen of screens) {
        if (!screen.uiWidth || !screen.uiHeight) continue;
        // Hide sibling screens so each renders only its own subtree — all UI
        // meshes share UI_LAYER, and each screen may have a different scale.
        const others = screens.filter((s) => s !== screen && s.entity);
        for (const o of others) o.entity.object3D.visible = false;
        this.camera.left = 0;
        this.camera.right = screen.uiWidth;
        this.camera.top = 0;
        this.camera.bottom = -screen.uiHeight;
        this.camera.updateProjectionMatrix();
        renderer.render(this.engine.scene, this.camera);
        for (const o of others) o.entity.object3D.visible = true;
      }
    } finally {
      renderer.autoClear = prevAutoClear;
      renderer.autoClearColor = prevAutoClearColor;
      renderer.autoClearDepth = prevAutoClearDepth;
    }
  }

  // -- Hit testing / picking -------------------------------------------------

  /** Canvas-relative CSS px → UI px of the given screen. */
  cssToUi(screen, clientX, clientY) {
    const canvas = this.engine.renderer?.domElement;
    if (!canvas || !screen.uiWidth) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: ((clientX - rect.left) / rect.width) * screen.uiWidth,
      y: ((clientY - rect.top) / rect.height) * screen.uiHeight,
    };
  }

  /**
   * Topmost element under a client-space point. `interactiveOnly` restricts
   * to raycastTarget elements (runtime input); the editor passes false so
   * any visible element is pickable.
   * Returns { entity, el, screen } or null.
   */
  hitTest(clientX, clientY, { interactiveOnly = true } = {}) {
    const screens = [...this.screens].sort(
      (a, b) => (b.props.sortOrder ?? 0) - (a.props.sortOrder ?? 0),
    );
    for (const screen of screens) {
      if (!screen.hitList || screen.entity?.object3D.visible === false) continue;
      const pt = this.cssToUi(screen, clientX, clientY);
      if (!pt) continue;
      for (let i = screen.hitList.length - 1; i >= 0; i--) {
        const item = screen.hitList[i];
        if (interactiveOnly && item.el && item.el.props.raycastTarget === false) continue;
        if (interactiveOnly && !item.el) continue;
        if (!rectContains(item.rect, pt.x, pt.y)) continue;
        if (item.clipRect && !rectContains(item.clipRect, pt.x, pt.y)) continue;
        // Skip invisible ancestors (visibility already pruned in layout via
        // continue, so hitList only contains visible entities).
        return { entity: item.entity, el: item.el, screen, point: pt };
      }
    }
    return null;
  }

  /** Nearest scroll component on `entity` or its ancestors. */
  #findScroll(entity) {
    for (let e = entity; e; e = e.parent) {
      const scroll = e.getComponent?.("uiscroll");
      if (scroll) return scroll;
    }
    return null;
  }

  /** Nearest button component on `entity` or its ancestors. */
  #findButton(entity) {
    for (let e = entity; e; e = e.parent) {
      const btn = e.getComponent?.("uibutton");
      if (btn && btn.props.interactable !== false) return btn;
    }
    return null;
  }

  // -- Input -----------------------------------------------------------------

  #bindInput() {
    const canvas = this.engine.renderer?.domElement;
    if (!canvas || canvas === this.boundCanvas) return;
    if (this.boundCanvas) this.#unbindInput();
    this.boundCanvas = canvas;
    this._onMove = (e) => this.#onPointerMove(e);
    this._onDown = (e) => this.#onPointerDown(e);
    this._onUp = (e) => this.#onPointerUp(e);
    this._onWheel = (e) => this.#onWheel(e);
    this._onLeave = () => this.#clearInteraction();
    canvas.addEventListener("pointermove", this._onMove);
    canvas.addEventListener("pointerdown", this._onDown);
    canvas.addEventListener("pointerup", this._onUp);
    canvas.addEventListener("wheel", this._onWheel, { passive: false });
    canvas.addEventListener("pointerleave", this._onLeave);
  }

  #unbindInput() {
    const canvas = this.boundCanvas;
    if (!canvas) return;
    canvas.removeEventListener("pointermove", this._onMove);
    canvas.removeEventListener("pointerdown", this._onDown);
    canvas.removeEventListener("pointerup", this._onUp);
    canvas.removeEventListener("wheel", this._onWheel);
    canvas.removeEventListener("pointerleave", this._onLeave);
    this.boundCanvas = null;
  }

  #clearInteraction() {
    if (this.pointer.hover) this.pointer.hover.setState?.("normal");
    if (this.pointer.downButton) this.pointer.downButton.setState?.("normal");
    this.pointer = { downButton: null, downX: 0, downY: 0, hover: null, scrollDrag: null };
  }

  #onPointerMove(e) {
    if (!this.engine.playing) return;
    const p = this.pointer;

    // Drag-scroll: past the slop threshold the press becomes a scroll drag.
    if (p.scrollDrag) {
      const { scroll, startScrollX, startScrollY, screen } = p.scrollDrag;
      const dx = (e.clientX - p.downX) / (screen.scale ?? 1);
      const dy = (e.clientY - p.downY) / (screen.scale ?? 1);
      if (!p.scrollDrag.active && Math.hypot(dx, dy) > CLICK_SLOP_PX) {
        p.scrollDrag.active = true;
        if (p.downButton) {
          p.downButton.setState?.("normal");
          p.downButton = null; // drag cancels the pending click
        }
      }
      if (p.scrollDrag.active) {
        if (scroll.props.horizontal) {
          scroll.scrollX = clampScroll(startScrollX - dx, scroll.contentW ?? 0, scroll.viewportW ?? 0);
        }
        if (scroll.props.vertical !== false) {
          scroll.scrollY = clampScroll(startScrollY - dy, scroll.contentH ?? 0, scroll.viewportH ?? 0);
        }
        return;
      }
    }

    const hit = this.hitTest(e.clientX, e.clientY);
    const button = hit ? this.#findButton(hit.entity) : null;
    if (button !== p.hover) {
      p.hover?.setState?.("normal");
      if (button && button !== p.downButton) button.setState?.("hover");
      p.hover = button;
      const canvas = this.boundCanvas;
      if (canvas) canvas.style.cursor = button ? "pointer" : "";
    }
    if (p.downButton && button === p.downButton) p.downButton.setState?.("pressed");
    else if (p.downButton) p.downButton.setState?.("normal");
  }

  #onPointerDown(e) {
    if (!this.engine.playing || e.button !== 0) return;
    const hit = this.hitTest(e.clientX, e.clientY);
    if (!hit) return;
    const p = this.pointer;
    p.downX = e.clientX;
    p.downY = e.clientY;
    const button = this.#findButton(hit.entity);
    if (button) {
      p.downButton = button;
      button.setState?.("pressed");
    }
    const scroll = this.#findScroll(hit.entity);
    if (scroll && scroll.props.dragScroll !== false) {
      p.scrollDrag = {
        scroll,
        screen: hit.screen,
        startScrollX: scroll.scrollX ?? 0,
        startScrollY: scroll.scrollY ?? 0,
        active: false,
      };
    }
  }

  #onPointerUp(e) {
    if (e.button !== 0) return;
    const p = this.pointer;
    const downButton = p.downButton;
    p.downButton = null;
    p.scrollDrag = null;
    if (!this.engine.playing || !downButton) return;
    downButton.setState?.(p.hover === downButton ? "hover" : "normal");
    const moved = Math.hypot(e.clientX - p.downX, e.clientY - p.downY);
    if (moved > CLICK_SLOP_PX) return;
    const hit = this.hitTest(e.clientX, e.clientY);
    if (hit && this.#findButton(hit.entity) === downButton) {
      downButton.click();
    }
  }

  #onWheel(e) {
    if (!this.engine.playing) return;
    const hit = this.hitTest(e.clientX, e.clientY);
    const scroll = hit ? this.#findScroll(hit.entity) : null;
    if (!scroll) return;
    e.preventDefault();
    const speed = scroll.props.wheelSpeed ?? 1;
    if (scroll.props.vertical !== false) {
      scroll.scrollY = clampScroll(
        (scroll.scrollY ?? 0) + e.deltaY * speed,
        scroll.contentH ?? 0,
        scroll.viewportH ?? 0,
      );
    } else if (scroll.props.horizontal) {
      scroll.scrollX = clampScroll(
        (scroll.scrollX ?? 0) + e.deltaY * speed,
        scroll.contentW ?? 0,
        scroll.viewportW ?? 0,
      );
    }
  }

  // -- Editor selection highlight ---------------------------------------------

  /** Editor-only: outline the given entity's computed rect (null = hide). */
  setHighlight(entityId) {
    this.highlight = entityId ? { entityId } : null;
    if (!this.highlight && this.highlightMesh) this.highlightMesh.visible = false;
  }

  #updateHighlight() {
    if (!this.highlight) return;
    const entity = this.engine.getEntity(this.highlight.entityId);
    const el = entity?.getComponent?.("uielement");
    const rect = el?.rect;
    if (!rect) {
      if (this.highlightMesh) this.highlightMesh.visible = false;
      return;
    }
    if (!this.highlightMesh) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(15), 3));
      const material = new THREE.LineBasicMaterial({ color: 0x4da3ff, depthTest: false, transparent: true });
      this.highlightMesh = new THREE.Line(geometry, material);
      this.highlightMesh.layers.set(UI_LAYER);
      this.highlightMesh.renderOrder = 100000;
      this.highlightMesh.frustumCulled = false;
      this.highlightMesh.userData.editorOnly = true;
      this.highlightMesh.raycast = () => {};
      this.engine.scene.add(this.highlightMesh);
    }
    const a = this.highlightMesh.geometry.attributes.position;
    const pts = [
      [rect.x, rect.y],
      [rect.x + rect.w, rect.y],
      [rect.x + rect.w, rect.y + rect.h],
      [rect.x, rect.y + rect.h],
      [rect.x, rect.y],
    ];
    for (let i = 0; i < 5; i++) a.setXYZ(i, pts[i][0], -pts[i][1], 0);
    a.needsUpdate = true;
    this.highlightMesh.visible = !this.engine.playing;
  }

  dispose() {
    this.unsubUpdate?.();
    this.unsubPost?.();
    this.#unbindInput();
    this.engine.off?.("play-changed", this.onPlayChanged);
    if (this.highlightMesh) {
      this.engine.scene.remove(this.highlightMesh);
      this.highlightMesh.geometry.dispose();
      this.highlightMesh.material.dispose();
      this.highlightMesh = null;
    }
  }
}

const _v2 = new THREE.Vector2();

/**
 * Lazily creates the per-engine UiSystem (or returns the existing one).
 * Stored as a property on the engine (not a WeakMap keyed by identity) so
 * the editor's lazy-engine Proxy shim — a different object that forwards
 * property access to the real instance — resolves the same system.
 */
export function getUiSystem(engine, { create = true } = {}) {
  let system = engine.uiSystem ?? null;
  if (!system && create) {
    system = new UiSystem(engine);
    engine.uiSystem = system;
  }
  return system;
}
