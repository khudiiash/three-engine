// Loads the Draco encoder + decoder emscripten modules for browser/WebView use.
//
// `draco3dgltf` ships CommonJS glue that statically `require("fs")`/`require("path")`
// — those calls only run on its Node branch (guarded by a `process.versions.node`
// check that is false in the WebView), but a bundler still has to *resolve* them,
// which fails for browser targets. To sidestep that entirely we import the glue as
// raw text and evaluate it with a stub `require`, then hand the emscripten factory
// the wasm bytes via its `wasmBinary` option (the glue honors it and skips all file
// I/O). These deps are editor-only — the exported player never compresses, it only
// decodes via three's DRACOLoader.
import encoderGlue from "draco3dgltf/draco_encoder_gltf_nodejs.js?raw";
import decoderGlue from "draco3dgltf/draco_decoder_gltf_nodejs.js?raw";
import encoderWasmUrl from "draco3dgltf/draco_encoder.wasm?url";
import decoderWasmUrl from "draco3dgltf/draco_decoder_gltf.wasm?url";

/** Evaluates the UMD/CommonJS emscripten glue and returns its factory export. */
function evalGlue(src) {
  const module = { exports: {} };
  // The glue's `require("fs")`/`require("path")` live behind a Node-only branch
  // that never executes here; the stub just satisfies the reference so nothing
  // has to be resolved at bundle time.
  const stubRequire = () => ({});
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", src)(module, module.exports, stubRequire);
  return module.exports;
}

let cache = null;

/** Instantiates (once) the Draco encoder + decoder modules. */
export async function getDracoWasm() {
  if (cache) return cache;
  cache = (async () => {
    const encoderFactory = evalGlue(encoderGlue);
    const decoderFactory = evalGlue(decoderGlue);
    const [encBin, decBin] = await Promise.all([
      fetch(encoderWasmUrl).then((r) => r.arrayBuffer()),
      fetch(decoderWasmUrl).then((r) => r.arrayBuffer()),
    ]);
    const [encoder, decoder] = await Promise.all([
      encoderFactory({ wasmBinary: new Uint8Array(encBin) }),
      decoderFactory({ wasmBinary: new Uint8Array(decBin) }),
    ]);
    return { encoder, decoder };
  })();
  return cache;
}
