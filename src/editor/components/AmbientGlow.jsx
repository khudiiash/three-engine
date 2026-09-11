import { useEffect, useRef, useState } from "react";
import { ensureEngine } from "../engineInstance.js";
import { getViewportHandle } from "../viewportHandle.js";
import { subscribeLayers } from "../panels/ViewportPanel.jsx";
import { getAmbientGlowLook, onAmbientGlowLook } from "../ambientGlowLook.js";
import {
  SAMPLE_WIDTH,
  disposeAmbientSampler,
  sampleHeightFor,
  sampleViewportColour,
} from "../ambientGlow.js";

/**
 * The viewport's light, spilling under the panels around it.
 *
 * A 32 px sample of the scene (see `ambientGlow.js`) is painted into a canvas
 * that is left SMALL in layout — a couple of hundred pixels — blurred, and
 * only then scaled up over the viewport. That order is half the performance
 * story: a filter applies to the element's own box and the transform happens
 * after, so the browser blurs a small bitmap and stretches the result rather
 * than blurring a three-thousand-pixel area.
 *
 * WHEN IT SAMPLES is the other half. On a slow timer it looked like lag —
 * the light arrived in visible steps behind the camera. Sampling every frame
 * regardless would spend a frame copy and a readback per frame on a
 * decoration. So it samples when the picture CAN have changed and idles when
 * it cannot:
 *
 *   · every frame the readback can keep up with while the camera moves —
 *     which is where the stepping showed and where the eye is looking
 *   · a slow heartbeat otherwise, for a scene that moves on its own (cloth
 *     in the wind, an animation, a light that turns)
 *   · nothing while the window is hidden or the frame loop is frozen
 *
 * So a still camera over a still scene costs one sample every half second,
 * and an orbit costs one per frame — which is exactly when the light was
 * asked to keep up. Each new sample is EASED into the one on screen, so
 * between two samples the colour is still travelling and the motion reads as
 * continuous rather than stepped.
 */

/** A scene can move without the camera; this is how often we look anyway. */
const HEARTBEAT_MS = 500;
/** How much of each new sample is taken. Lower is smoother and slower. */
const EASE = 0.5;
// The blurred bitmap's LAYOUT size. Bigger than the sample and much smaller
// than the screen: the blur is paid at this size (see the render note above),
// and the compositor stretches the result. Doubling it from 220×124 halved
// what was left of the colour banding after the masks moved off the scaled
// element — the blur radius doubles with it, so the light looks the same.
const BOX_W = 440;
const BOX_H = 248;

/** Each distinct state is reported once, so a glow that never appears can be
 *  told apart from one that is merely faint without adding a debug flag. */
const reported = new Set();
function report(message) {
  if (reported.has(message)) return;
  reported.add(message);
  console.log(`Ambient glow: ${message}`);
}

/** True when the camera has moved since the last call, and remembers it. */
function poseChanged(camera, pose) {
  const p = camera.position;
  const q = camera.quaternion;
  const next = [p.x, p.y, p.z, q.x, q.y, q.z, q.w, camera.fov ?? 0, camera.zoom ?? 1];
  for (let i = 0; i < next.length; i++) {
    if (pose[i] !== next[i]) {
      pose.set(next);
      return true;
    }
  }
  return false;
}

export function AmbientGlow() {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const frameRef = useRef(null);
  const veilRef = useRef(null);
  const boxRef = useRef(null);
  const scratchRef = useRef(null);
  const placeRef = useRef(null);
  const [visible, setVisible] = useState(true);
  // Read through a ref, not a dependency: the sampling loop must not be torn
  // down and restarted every time the user nudges a slider.
  const lookRef = useRef(getAmbientGlowLook());

  useEffect(() => subscribeLayers((layers) => setVisible(layers.ambient !== false)), []);

  // The two numbers from Project Settings, applied as they change.
  useEffect(
    () =>
      onAmbientGlowLook((look) => {
        lookRef.current = look;
        wrapRef.current?.style.setProperty("--ambient-strength", String(look.intensity));
        placeRef.current?.();
      }),
    [],
  );
  useEffect(() => {
    wrapRef.current?.style.setProperty("--ambient-strength", String(lookRef.current.intensity));
  }, [visible]);

  useEffect(() => {
    if (!visible) return undefined;
    let stopped = false;
    let frame = 0;
    let inFlight = false;
    let lastSample = 0;
    let engineRef = null;
    const pose = new Float64Array(9).fill(NaN);

    // Reads the viewport rather than taking a rect, so a spread change can
    // re-place the light immediately instead of waiting for the next sample.
    const place = (rect = getViewportHandle()?.canvas?.getBoundingClientRect()) => {
      const wrap = wrapRef.current;
      const frame = frameRef.current;
      const box = boxRef.current;
      if (!wrap || !frame || !box || !rect || !(rect.width > 0) || !(rect.height > 0)) return;
      // How far past the viewport's edges the light reaches, in CSS pixels.
      // A fixed distance rather than a multiple of the viewport: a halo
      // should look the same whether the viewport is a third of the window
      // or all of it.
      const reach = lookRef.current.spread;
      const width = rect.width + reach * 2;
      const height = rect.height + reach * 2;
      wrap.style.left = `${rect.left + rect.width / 2}px`;
      wrap.style.top = `${rect.top + rect.height / 2}px`;
      // The frame is the halo at its REAL size, so its two fades rasterize at
      // screen resolution; only the bitmap inside is scaled. Scaling the
      // masked element instead is what drew rings — see the sheet.
      frame.style.width = `${width}px`;
      frame.style.height = `${height}px`;
      box.style.transform = `scale(${width / BOX_W}, ${height / BOX_H})`;
      // The fades cover exactly the band OUTSIDE the picture: the reach as a
      // share of the frame, per axis.
      frame.style.setProperty("--ambient-fade-x", `${(reach / width) * 100}%`);
      frame.style.setProperty("--ambient-fade-y", `${(reach / height) * 100}%`);
    };
    placeRef.current = place;

    const draw = (pixels, height) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const fresh = canvas.width !== SAMPLE_WIDTH || canvas.height !== height;
      if (fresh) {
        canvas.width = SAMPLE_WIDTH;
        canvas.height = height;
      }
      const context = canvas.getContext("2d");
      if (!context) return;
      // `putImageData` REPLACES pixels and ignores globalAlpha, which is the
      // step the eye was catching. The sample lands on a scratch canvas and
      // is drawn over the visible one at partial alpha, so what is on screen
      // travels toward the new colour instead of jumping to it.
      let scratch = scratchRef.current;
      if (!scratch || scratch.width !== SAMPLE_WIDTH || scratch.height !== height) {
        scratch = document.createElement("canvas");
        scratch.width = SAMPLE_WIDTH;
        scratch.height = height;
        scratchRef.current = scratch;
      }
      const scratchContext = scratch.getContext("2d");
      if (!scratchContext) return;
      scratchContext.putImageData(new ImageData(new Uint8ClampedArray(pixels), SAMPLE_WIDTH, height), 0, 0);
      // A resize clears the canvas, so the first draw into it must be whole
      // or the glow fades up from nothing every time the viewport reshapes.
      context.globalAlpha = fresh ? 1 : EASE;
      context.drawImage(scratch, 0, 0);
      context.globalAlpha = 1;
    };

    const loop = async (now) => {
      if (stopped) return;
      frame = requestAnimationFrame(loop);
      if (inFlight || document.hidden) return;

      const handle = getViewportHandle();
      const camera = handle?.camera;
      const element = handle?.canvas;
      if (!camera || !element) {
        report(`no viewport to sample (camera: ${!!camera}, canvas: ${!!element})`);
        return;
      }
      const rect = element.getBoundingClientRect();
      if (!(rect.width > 0) || !(rect.height > 0)) return;

      if (!engineRef) {
        engineRef = await ensureEngine().catch(() => null);
        if (stopped || !engineRef) return;
      }
      const engine = engineRef;
      if (!engine.renderer || !engine.scene) return;
      // Nothing is being drawn (an unfocused viewport is frozen): whatever is
      // on screen is still the last frame, so its light is still correct.
      if (!(engine.stats?.readout?.fps > 0)) return;

      const moved = poseChanged(camera, pose);
      if (!moved && now - lastSample < HEARTBEAT_MS) return;

      inFlight = true;
      try {
        const height = sampleHeightFor(rect.width / rect.height);
        // The sample is the NEXT presented frame, copied on the GPU (see
        // ambientGlow.js) — the scene is never rendered a second time.
        const pixels = await sampleViewportColour(engine, camera, height);
        if (stopped || !pixels) return;
        lastSample = now;
        place(rect);
        draw(pixels, height);
        report(
          `sampling ${SAMPLE_WIDTH}x${height} over a ${Math.round(rect.width)}x${Math.round(rect.height)} ` +
            `viewport, every frame while the camera moves`,
        );
      } finally {
        inFlight = false;
      }
    };

    frame = requestAnimationFrame(loop);
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
    };
  }, [visible]);

  useEffect(() => () => disposeAmbientSampler(), []);

  if (!visible) return null;
  // Four elements, and each one earns its place: the WRAP is a point at the
  // viewport's centre, the FRAME is the halo at its real size and carries the
  // horizontal fade, the VEIL carries the vertical one and the strength, and
  // only the BOX is scaled — it holds nothing but the blurred bitmap. Two
  // fades on one element would need `mask-composite` (newer than anything
  // else in this sheet), and a single radial mask is an ellipse inscribed in
  // the box: the light would reach out from the middle of each edge and die
  // at the corners, which is not how a screen spills.
  return (
    <div className="ambient-glow" ref={wrapRef} aria-hidden="true">
      <div className="ambient-glow-frame" ref={frameRef}>
        <div className="ambient-glow-veil" ref={veilRef}>
          <div className="ambient-glow-box" ref={boxRef}>
            <canvas ref={canvasRef} className="ambient-glow-canvas" width={SAMPLE_WIDTH} height={18} />
          </div>
        </div>
      </div>
    </div>
  );
}
