# Three Engine

A Tauri 2 + React (plain JS) game engine editor built around three.js r185 WebGPU/TSL,
PlayCanvas/Unity-style. Render with WebGPU when available, fall back to WebGL2.

## Features

- WebGPU-first renderer with WebGL2 fallback, running inside Tauri 2
- Entity + component editor (mesh, light, camera, model, script, particles, animation)
- Undo / redo command bus, scene save / load, drag-and-drop assets (.glb, textures, scripts)
- Script components with TS decorator field attributes and hot reload
- Play / Stop mode with snapshot + restore
- Node-based shader graph editor and node-based particle system editor
- Animator with state-machine .anim controllers
- Material assets (.mat) shared across meshes, with PBR map handling
- Self-contained game export (`npm run build:player`) that ships the engine + a scene

## Running

```bash
npm install
npm run tauri dev   # full editor in a Tauri window
npm run dev         # vite-only, opens in browser (limited without Tauri APIs)
npm run build       # production editor build
npm run build:player # export a self-contained game template to dist-player/
```

## Project layout

- `src/engine/` — React-free, Tauri-free runtime (exported games ship this)
- `src/editor/` — React editor: command bus, zustand stores, dockview shell, panels
- `src/player/` — React-free game runtime template (consumes `src/engine/`)
- `src-tauri/` — Rust side: filesystem, dialogs, opener plugin, bundle config

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)