//! kimodo.cpp text-to-motion, loaded IN-PROCESS through its stable C API
//! (`include/kimodo/kimodo_capi.h` in the kimodo.cpp checkout).
//!
//! Why this exists alongside the `kmd-generate` CLI spawn: generation is an
//! offline authoring task on the user's own machine, so the native/WebView
//! boundary is ours to choose — and a dlopen'd shared library loses nothing
//! to the CLI path except a process launch and a model reload per
//! generation. The model handle is cached across calls keyed on the weight
//! paths, which turns "generate" into pure diffusion time after the first
//! run. It stays a RUNTIME load, deliberately: no build-time link, no cargo
//! feature, and a machine without kimodo built as a DLL is simply unchanged
//! (generate_motion falls back to the CLI).
//!
//! DLL layout mirrors the VS shared build of kimodo.cpp: `kimodo.dll` in
//! `lib_dir`, the ggml runtime DLLs (`ggml-base`, `ggml`, `ggml-cpu`) in
//! `ggml_dir` (the same build tree's `bin/Release`). The ggml libraries are
//! preloaded by full path and kept alive forever: once a module is in the
//! process' module table, the loader resolves kimodo.dll's import-table
//! entries against it BY NAME, immune to PATH and search-order quirks.
//!
//! Safety: symbols are fetched from the process-lifetime library handle; the
//! LOADED mutex serializes native state across load AND generate (one user,
//! one generation at a time); C strings are temporary CStrings that outlive
//! each call; the `size` fields carry the struct's real size — the C API
//! rejects a mismatched ABI by contract.

use libloading::{Library, Symbol};
use std::ffi::{c_char, c_float, c_int, c_uint, c_void, CString};
use std::os::raw::c_ulonglong;
use std::path::Path;
use std::sync::Mutex;

const DEVICE_AUTO: c_int = 0;
const CFG_WEIGHT: c_float = 2.0; // what kmd-generate hardcodes

#[repr(C)]
struct KimodoRuntimeOptions {
    size: c_uint,
    threads: c_uint,
    device: c_int,
    backend_dir: *const c_char,
}

#[repr(C)]
struct KimodoGenerationOptions {
    size: c_uint,
    seed: c_ulonglong,
    frames: c_uint,
    diffusion_steps: c_uint,
    text_cfg_weight: c_float,
    constraint_cfg_weight: c_float,
}

type ModelPtr = *mut c_void;
type MotionPtr = *mut c_void;

/// Raw native handle in the process-wide cache. `Send` by necessity — the
/// cache is a static — and safe in practice: the handle is only ever touched
/// under the LOADED mutex, and never after kimodo_model_free.
struct ModelHandle(ModelPtr);
unsafe impl Send for ModelHandle {}

type FnAbiVersion = unsafe extern "C" fn() -> c_int;
type FnModelLoad = unsafe extern "C" fn(
    motion_gguf: *const c_char,
    text_gguf: *const c_char,
    text_adapter_gguf: *const c_char,
    options: *const KimodoRuntimeOptions,
    err: *mut c_char,
    err_len: c_int,
) -> ModelPtr;
type FnModelFree = unsafe extern "C" fn(model: ModelPtr);
type FnGenerate = unsafe extern "C" fn(
    model: ModelPtr,
    prompt: *const c_char,
    options: *const KimodoGenerationOptions,
    err: *mut c_char,
    err_len: c_int,
) -> MotionPtr;
type FnMotionFree = unsafe extern "C" fn(motion: MotionPtr);
type FnMotionFrames = unsafe extern "C" fn(motion: MotionPtr) -> c_int;
type FnMotionJoints = unsafe extern "C" fn(motion: MotionPtr) -> c_int;
type FnMotionRotations = unsafe extern "C" fn(motion: MotionPtr) -> *const c_float;
type FnMotionRoots = unsafe extern "C" fn(motion: MotionPtr) -> *const c_float;

/// One loaded library plus its preloaded dependencies and cached model.
/// Lives for the process lifetime (dropping a Library unloads its code, and
/// kimodo.dll's imports depend on the ggml preloads staying resident).
struct Loaded {
    _ggml: Vec<Library>,
    kimodo: Library,
    model: ModelHandle,
    /// (motion gguf, text bundle) the cached model was loaded from.
    key: (String, String),
}

static LOADED: Mutex<Option<Loaded>> = Mutex::new(None);

/// Generated motion, exactly the bytes `kmd-generate` writes to its output
/// dir: little-endian f32, `[T,3]` root positions and `[T,J,4]` XYZW local
/// rotations.
pub struct FfiMotion {
    pub frames: u32,
    /// Read by the env-gated test; the JS retarget validates it against its
    /// own SOMA table.
    #[allow(dead_code)]
    pub joints: u32,
    pub roots: Vec<u8>,
    pub rots: Vec<u8>,
}

fn err_string(buf: &[u8]) -> String {
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..end]).into_owned()
}

/// Load a DLL by full path with the altered search flag: a DLL's OWN
/// directory is searched first for its dependencies. Without it, ggml.dll's
/// import of ggml-cpu.dll fails — plain LoadLibraryW searches the app dir and
/// PATH, never the sibling directory the DLL actually lives in.
#[cfg(windows)]
fn load_lib(path: &Path) -> Result<Library, String> {
    // SAFETY: path is a valid file; LOAD_WITH_ALTERED_SEARCH_PATH makes the
    // DLL's own directory the first place its dependencies are looked up.
    let raw = unsafe {
        libloading::os::windows::Library::load_with_flags(
            path,
            libloading::os::windows::LOAD_WITH_ALTERED_SEARCH_PATH,
        )
    }
    .map_err(|e| format!("LoadLibraryExW {}: {e}", path.display()))?;
    Ok(Library::from(raw))
}

#[cfg(not(windows))]
fn load_lib(path: &Path) -> Result<Library, String> {
    // SAFETY: plain library load; handle kept alive by the caller.
    unsafe { Library::new(path) }.map_err(|e| format!("dlopen {}: {e}", path.display()))
}

/// Load (or reuse) the shared library + model for these weights, then run
/// `f` — the whole thing under one lock, because the native model is
/// single-threaded state.
fn with_loaded<T>(
    lib_dir: &Path,
    ggml_dir: Option<&Path>,
    motion_gguf: &str,
    text_bundle: &str,
    f: impl FnOnce(&Library, ModelPtr) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = LOADED.lock().map_err(|_| "kimodo loader mutex poisoned")?;

    let reuse = guard
        .as_ref()
        .map(|l| l.key.0 == motion_gguf && l.key.1 == text_bundle)
        .unwrap_or(false);
    if !reuse {
        if let Some(old) = guard.take() {
            // SAFETY: model came from this same library handle.
            unsafe {
                let free: Symbol<FnModelFree> = old
                    .kimodo
                    .get(b"kimodo_model_free\0")
                    .map_err(|e| e.to_string())?;
                free(old.model.0);
            }
        }

        let kimodo_path = lib_dir.join(if cfg!(windows) {
            "kimodo.dll"
        } else {
            "libkimodo.so"
        });
        if !kimodo_path.exists() {
            return Err(format!(
                "kimodo shared library not found at {}",
                kimodo_path.display()
            ));
        }
        // Dependencies first: a module already in the process' module table
        // wins the loader's by-name resolution for kimodo.dll's imports.
        let mut ggml = Vec::new();
        if let Some(dir) = ggml_dir {
            for name in [
                "ggml-base.dll",
                "ggml.dll",
                "ggml-cpu.dll",
                "libggml-base.so",
                "libggml.so",
                "libggml-cpu.so",
            ] {
                let p = dir.join(name);
                if p.exists() {
                    ggml.push(load_lib(&p)?);
                }
            }
        }
        let kimodo = load_lib(&kimodo_path)?;
        // ABI ping before anything expensive: rejects a foreign/old DLL loudly.
        let version = unsafe {
            let abi: Symbol<FnAbiVersion> = kimodo
                .get(b"kimodo_abi_version\0")
                .map_err(|e| e.to_string())?;
            abi()
        };
        if version != 1 {
            return Err(format!("kimodo ABI version {version}, expected 1"));
        }

        let c_motion = CString::new(motion_gguf).map_err(|_| "motion path has interior NUL")?;
        let c_text = CString::new(text_bundle).map_err(|_| "text bundle path has interior NUL")?;
        let opts = KimodoRuntimeOptions {
            size: std::mem::size_of::<KimodoRuntimeOptions>() as c_uint,
            threads: 0, // runtime default
            device: DEVICE_AUTO,
            backend_dir: std::ptr::null(),
        };
        let mut err = [0u8; 512];
        // SAFETY: strings outlive the call; err buffer is ours.
        let model = unsafe {
            let load: Symbol<FnModelLoad> = kimodo
                .get(b"kimodo_model_load\0")
                .map_err(|e| e.to_string())?;
            load(
                c_motion.as_ptr(),
                c_text.as_ptr(),
                std::ptr::null(),
                &opts,
                err.as_mut_ptr() as *mut c_char,
                err.len() as c_int,
            )
        };
        if model.is_null() {
            return Err(format!("kimodo model load failed: {}", err_string(&err)));
        }
        *guard = Some(Loaded {
            _ggml: ggml,
            kimodo,
            model: ModelHandle(model),
            key: (motion_gguf.to_string(), text_bundle.to_string()),
        });
    }

    let loaded = guard.as_ref().expect("model present after load");
    f(&loaded.kimodo, loaded.model.0)
}

/// Generate one motion through the loaded library. Heavy the first call per
/// weight pair (model load), then diffusion-only.
pub fn generate(
    lib_dir: &Path,
    ggml_dir: Option<&Path>,
    motion_gguf: &str,
    text_bundle: &str,
    prompt: &str,
    frames: u32,
    steps: u32,
    seed: u64,
) -> Result<FfiMotion, String> {
    let c_prompt = CString::new(prompt).map_err(|_| "prompt has interior NUL")?;
    with_loaded(
        lib_dir,
        ggml_dir,
        motion_gguf,
        text_bundle,
        |kimodo, model| {
            let opts = KimodoGenerationOptions {
                size: std::mem::size_of::<KimodoGenerationOptions>() as c_uint,
                seed: seed as c_ulonglong,
                frames,
                diffusion_steps: steps,
                text_cfg_weight: CFG_WEIGHT,
                constraint_cfg_weight: CFG_WEIGHT,
            };
            let mut err = [0u8; 512];
            // SAFETY: prompt/options outlive the call; err buffer is ours; the
            // returned motion is released before returning.
            let motion = unsafe {
                let gen: Symbol<FnGenerate> = kimodo
                    .get(b"kimodo_generate\0")
                    .map_err(|e| e.to_string())?;
                gen(
                    model,
                    c_prompt.as_ptr(),
                    &opts,
                    err.as_mut_ptr() as *mut c_char,
                    err.len() as c_int,
                )
            };
            if motion.is_null() {
                return Err(format!("kimodo generation failed: {}", err_string(&err)));
            }
            let result = unsafe {
                let n_frames: Symbol<FnMotionFrames> = kimodo
                    .get(b"kimodo_motion_frames\0")
                    .map_err(|e| e.to_string())?;
                let n_joints: Symbol<FnMotionJoints> = kimodo
                    .get(b"kimodo_motion_joints\0")
                    .map_err(|e| e.to_string())?;
                let rots_ptr: Symbol<FnMotionRotations> = kimodo
                    .get(b"kimodo_motion_local_rotations_xyzw\0")
                    .map_err(|e| e.to_string())?;
                let roots_ptr: Symbol<FnMotionRoots> = kimodo
                    .get(b"kimodo_motion_root_positions\0")
                    .map_err(|e| e.to_string())?;
                let frames = n_frames(motion);
                let joints = n_joints(motion);
                if frames <= 0 || joints <= 0 {
                    Err(format!("kimodo returned {frames}x{joints} motion"))
                } else {
                    let (roots, rots) = (roots_ptr(motion), rots_ptr(motion));
                    if roots.is_null() || rots.is_null() {
                        Err("kimodo returned null motion buffers".to_string())
                    } else {
                        // Borrowed buffers, valid until motion_free — copy now.
                        // Little-endian f32: the C API's contract and every
                        // machine this editor ships on agree.
                        let roots: Vec<u8> =
                            std::slice::from_raw_parts(roots, (frames * 3) as usize)
                                .iter()
                                .flat_map(|v| v.to_le_bytes())
                                .collect();
                        let rots: Vec<u8> =
                            std::slice::from_raw_parts(rots, (frames * joints * 4) as usize)
                                .iter()
                                .flat_map(|v| v.to_le_bytes())
                                .collect();
                        Ok(FfiMotion {
                            frames: frames as u32,
                            joints: joints as u32,
                            roots,
                            rots,
                        })
                    }
                }
            };
            // SAFETY: motion came from this same library handle this call.
            unsafe {
                let free: Symbol<FnMotionFree> = kimodo
                    .get(b"kimodo_motion_free\0")
                    .map_err(|e| e.to_string())?;
                free(motion);
            }
            result
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live round trip against a real build + weights — run by hand on a
    /// machine with the kimodo.cpp checkout, NOT in CI (13 GB of weights and
    /// a minute of diffusion are not test fixtures):
    ///   KIMODO_FFI_TEST_DIR=.../kimodo.cpp cargo test --kimodo_ffi  (from src-tauri)
    #[test]
    #[ignore]
    fn generates_against_real_weights() {
        let dir = std::env::var("KIMODO_FFI_TEST_DIR").expect("set KIMODO_FFI_TEST_DIR");
        let dir = Path::new(&dir);
        let motion = generate(
            &dir.join("build/vs-dll/Release"),
            Some(&dir.join("build/vs-dll/bin/Release")),
            dir.join("models/kimodo-soma-rp-v1.1-f32.gguf")
                .to_str()
                .unwrap(),
            dir.join("generated/llm2vec-text-bundle").to_str().unwrap(),
            "a person walks forward at a steady pace",
            45,
            25,
            42,
        )
        .expect("ffi generation");
        assert_eq!(motion.frames, 45);
        assert_eq!(motion.joints, 30);
        assert_eq!(motion.roots.len(), 45 * 3 * 4);
        assert_eq!(motion.rots.len(), 45 * 30 * 4 * 4);
        // A second call must hit the cached model, not reload it (cannot
        // observe the time here, but the same handle must still work).
        let again = generate(
            &dir.join("build/vs-dll/Release"),
            Some(&dir.join("build/vs-dll/bin/Release")),
            dir.join("models/kimodo-soma-rp-v1.1-f32.gguf")
                .to_str()
                .unwrap(),
            dir.join("generated/llm2vec-text-bundle").to_str().unwrap(),
            "a person jumps up",
            30,
            25,
            7,
        )
        .expect("cached ffi generation");
        assert_eq!(again.frames, 30);
    }
}
