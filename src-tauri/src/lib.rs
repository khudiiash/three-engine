use serde::Serialize;
use std::fs;
use std::path::Path;

#[tauri::command]
fn save_scene(path: String, contents: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_scene(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct DirEntryInfo {
    name: String,
    path: String,
    is_dir: bool,
    ext: String,
}

/// Lists the immediate children of `path` (directories first, then files, both A-Z).
#[tauri::command]
fn list_dir(path: String) -> Result<Vec<DirEntryInfo>, String> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(&path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let ext = Path::new(&name)
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        entries.push(DirEntryInfo {
            name,
            path: entry.path().to_string_lossy().into_owned(),
            is_dir: file_type.is_dir(),
            ext,
        });
    }
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

/// Reads a file's raw bytes, for feeding into blob URLs (models, textures).
///
/// Returns a `tauri::ipc::Response` rather than `Vec<u8>` on purpose: a plain
/// `Vec<u8>` return value is serialized to the frontend as a JSON array of
/// numbers, which for a multi-MB model means shipping (and parsing) tens of
/// millions of JSON tokens — 15-20s of stall on a large `.glb`. `Response`
/// travels over the raw IPC channel as bytes, and `invoke` resolves it to an
/// `ArrayBuffer` on the JS side, which we wrap in a Blob directly.
#[tauri::command]
fn read_binary_file(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Reads a file as UTF-8 text (script source).
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Last-modified time in fractional seconds since the Unix epoch, used to
/// detect script file changes for hot reload without a filesystem watcher.
#[tauri::command]
fn stat_file(path: String) -> Result<f64, String> {
    let modified = fs::metadata(&path)
        .map_err(|e| e.to_string())?
        .modified()
        .map_err(|e| e.to_string())?;
    let duration = modified
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?;
    Ok(duration.as_secs_f64())
}

fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let dest = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &dest)?;
        } else {
            fs::copy(entry.path(), &dest)?;
        }
    }
    Ok(())
}

/// Copies the prebuilt player template into `out_dir`, writes scene.json,
/// and copies referenced assets to their relative destinations.
#[tauri::command]
fn export_game(
    out_dir: String,
    scene_json: String,
    assets: Vec<(String, String)>,
    files: Vec<(String, String)>,
) -> Result<(), String> {
    // Dev cwd is src-tauri; packaged builds would need a resource path (debt).
    let player = ["../dist-player", "dist-player"]
        .iter()
        .map(Path::new)
        .find(|p| p.join("index.html").exists())
        .ok_or("Player template not found — run `npm run build:player` first")?;
    let out = Path::new(&out_dir);
    copy_dir(player, out).map_err(|e| e.to_string())?;
    fs::write(out.join("scene.json"), scene_json).map_err(|e| e.to_string())?;
    for (src, rel) in assets {
        let dest = out.join(&rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::copy(&src, &dest).map_err(|e| format!("copy {src}: {e}"))?;
    }
    for (rel, contents) in files {
        let dest = out.join(&rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&dest, contents).map_err(|e| format!("write {rel}: {e}"))?;
    }
    Ok(())
}

/// Creates a directory (and any missing parents).
#[tauri::command]
fn create_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

/// Renames or moves a file/directory. Refuses to clobber an existing target.
#[tauri::command]
fn rename_path(from: String, to: String) -> Result<(), String> {
    if Path::new(&to).exists() {
        return Err(format!("\"{to}\" already exists"));
    }
    fs::rename(&from, &to).map_err(|e| e.to_string())
}

/// Deletes a file or directory (recursively).
#[tauri::command]
fn delete_path(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.is_dir() {
        fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        fs::remove_file(p).map_err(|e| e.to_string())
    }
}

/// Copies external files/folders (OS drag-drop import) into `dest_dir`,
/// uniquifying names instead of clobbering. Returns the created paths.
#[tauri::command]
fn import_files(paths: Vec<String>, dest_dir: String) -> Result<Vec<String>, String> {
    let dest_root = Path::new(&dest_dir);
    fs::create_dir_all(dest_root).map_err(|e| e.to_string())?;
    let mut imported = Vec::new();
    for src in paths {
        let src_path = Path::new(&src);
        let name = src_path
            .file_name()
            .ok_or_else(|| format!("bad path: {src}"))?
            .to_string_lossy()
            .into_owned();
        let stem = Path::new(&name)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| name.clone());
        let ext = Path::new(&name)
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        let mut dest = dest_root.join(&name);
        for i in 1.. {
            if !dest.exists() {
                break;
            }
            dest = dest_root.join(format!("{stem} {i}{ext}"));
        }
        if src_path.is_dir() {
            copy_dir(src_path, &dest).map_err(|e| e.to_string())?;
        } else {
            fs::copy(src_path, &dest).map_err(|e| format!("copy {src}: {e}"))?;
        }
        imported.push(dest.to_string_lossy().into_owned());
    }
    Ok(imported)
}

/// Lets the frontend surface messages in the dev terminal (WebView console
/// output is otherwise invisible during `tauri dev`).
#[tauri::command]
fn write_binary_file(path: String, contents: Vec<u8>) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
fn frontend_log(message: String) {
    println!("[frontend] {message}");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            save_scene,
            load_scene,
            list_dir,
            read_binary_file,
            read_text_file,
            stat_file,
            create_dir,
            rename_path,
            delete_path,
            import_files,
            export_game,
            write_binary_file,
            frontend_log
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
