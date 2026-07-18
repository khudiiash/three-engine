const STORAGE_PREFIX = "engine.editorCamera.v1:";

function isFiniteVector(value, length) {
  return Array.isArray(value) && value.length === length && value.every(Number.isFinite);
}

/** Builds a stable, project-scoped key for one editor scene. */
export function getEditorCameraStorageKey(rootPath, sceneIdentity) {
  if (!sceneIdentity) return null;
  const scope = rootPath ? rootPath.replaceAll("\\", "/").toLowerCase() : "session";
  return `${STORAGE_PREFIX}${encodeURIComponent(`${scope}:${sceneIdentity}`)}`;
}

export function loadEditorCamera(key) {
  if (!key) return null;
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!parsed || parsed.version !== 1) return null;
    if (!isFiniteVector(parsed.position, 3) || !isFiniteVector(parsed.direction, 3)) return null;
    if (!isFiniteVector(parsed.quaternion, 4) || !isFiniteVector(parsed.target, 3) || !isFiniteVector(parsed.up, 3)) return null;
    if (!Number.isFinite(parsed.zoom)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveEditorCamera(key, pose) {
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify({ version: 1, ...pose }));
  } catch {
    // Camera preferences are best-effort and should never interrupt editing.
  }
}
