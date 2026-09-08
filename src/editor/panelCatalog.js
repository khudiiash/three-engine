import {
  Activity,
  Aperture,
  AudioWaveform,
  Blocks,
  Bot,
  Box,
  Boxes,
  BrainCircuit,
  FileCode,
  Film,
  FolderOpen,
  Gamepad2,
  GitBranch,
  Globe,
  Hammer,
  Image,
  Keyboard,
  Layers,
  Library,
  ListTree,
  Music,
  Package,
  PersonStanding,
  Puzzle,
  Settings,
  Settings2,
  Shapes,
  SlidersHorizontal,
  Sparkles,
  SquareTerminal,
  Store,
  Terminal,
  Type,
  WandSparkles,
  Waypoints,
  Workflow,
  Zap,
} from "./icons/index.jsx";

/**
 * The panel catalog: every dock panel's glyph, title and preferred position,
 * plus the families the launcher groups them in.
 *
 * Lives apart from EditorShell.jsx so the tab renderer (PanelTab.jsx) and the
 * launcher (PanelLauncher.jsx) can read it without importing the shell — which
 * imports both of them. The glyph is the panel's identity in the tab strip:
 * an inactive tab shows only the glyph, so each one has to be tellable from
 * its neighbours at 14 px.
 */
export const PANEL_ICONS = {
  viewport: Box,
  game: Gamepad2,
  hierarchy: ListTree,
  inspector: SlidersHorizontal,
  assets: FolderOpen,
  console: SquareTerminal,
  shaderGraph: Waypoints,
  particles: Sparkles,
  vfx: WandSparkles,
  animator: PersonStanding,
  timeline: Film,
  postprocess: Aperture,
  geometryEditor: Shapes,
  textureEditor: Image,
  eventGraph: Workflow,
  code: FileCode,
  polyhaven: Library,
  ambientcg: Layers,
  sketchfab: Globe,
  polypizza: Boxes,
  kaykit: Blocks,
  fab: Store,
  itchio: Package,
  audioLibrary: Music,
  fontLibrary: Type,
  sceneSettings: Settings2,
  projectSettings: Settings,
  build: Hammer,
  modules: Puzzle,
  input: Keyboard,
  events: Zap,
  audioEditor: AudioWaveform,
  performance: Activity,
  terminal: Terminal,
  git: GitBranch,
  mcp: Bot,
  ai: BrainCircuit,
};

/** Where each panel prefers to (re)open. referencePanel falls back if closed too. */
export const PANEL_SPECS = {
  viewport: { icon: PANEL_ICONS.viewport, title: "Viewport" },
  // Tabbed WITH the viewport, not beside it: they show the same renderer canvas
  // (only one exists — see viewportCanvas.js), so side-by-side would mean one of
  // them is always a placeholder taking up half the screen.
  game: { icon: PANEL_ICONS.game, title: "Game", position: { referencePanel: "viewport", direction: "within" } },
  hierarchy: { icon: PANEL_ICONS.hierarchy, title: "Hierarchy", position: { referencePanel: "viewport", direction: "left" }, initialWidth: 260 },
  inspector: { icon: PANEL_ICONS.inspector, title: "Inspector", position: { referencePanel: "viewport", direction: "right" }, initialWidth: 320 },
  assets: { icon: PANEL_ICONS.assets, title: "Assets", position: { referencePanel: "viewport", direction: "below" }, initialHeight: 200 },
  console: { icon: PANEL_ICONS.console, title: "Console", position: { referencePanel: "assets", direction: "within" } },
  shaderGraph: { icon: PANEL_ICONS.shaderGraph, title: "Shader Graph", position: { referencePanel: "assets", direction: "within" } },
  // Node editors dock with Assets (the full-width strip under the viewport),
  // NOT with the Inspector: the Inspector column is ~320px, and a graph fitted
  // into 320px renders every node as an unreadable postage stamp.
  vfx: { icon: PANEL_ICONS.vfx, title: "VFX", position: { referencePanel: "assets", direction: "within" } },
  particles: { icon: PANEL_ICONS.particles, title: "Particles", position: { referencePanel: "assets", direction: "within" } },
  animator: { icon: PANEL_ICONS.animator, title: "Animator", position: { referencePanel: "assets", direction: "within" } },
  // Same reasoning as the node editors: a dope sheet is a wide, short surface —
  // it needs the full-width strip under the viewport, not the 320px column.
  timeline: { icon: PANEL_ICONS.timeline, title: "Timeline", position: { referencePanel: "assets", direction: "within" }, initialHeight: 260 },
  sceneSettings: { icon: PANEL_ICONS.sceneSettings, title: "Scene Settings", position: { referencePanel: "inspector", direction: "within" } },
  projectSettings: { icon: PANEL_ICONS.projectSettings, title: "Project Settings", position: { referencePanel: "inspector", direction: "within" } },
  build: { icon: PANEL_ICONS.build, title: "Build", position: { referencePanel: "inspector", direction: "within" } },
  modules: { icon: PANEL_ICONS.modules, title: "Modules", position: { referencePanel: "inspector", direction: "within" } },
  input: { icon: PANEL_ICONS.input, title: "Input", position: { referencePanel: "viewport", direction: "below" }, initialHeight: 280 },
  events: { icon: PANEL_ICONS.events, title: "Events", position: { referencePanel: "viewport", direction: "below" }, initialHeight: 300 },
  eventGraph: { icon: PANEL_ICONS.eventGraph, title: "Event Graph", position: { referencePanel: "viewport", direction: "within" } },
  geometryEditor: { icon: PANEL_ICONS.geometryEditor, title: "Geometry Editor", position: { referencePanel: "viewport", direction: "within" } },
  // Docks with the Assets strip, like the Shader Graph and Particles panels:
  // a node graph in the 320px Inspector column is a postage stamp, and this
  // one now also carries a document toolbar (which `.post`, save, save as).
  postprocess: { icon: PANEL_ICONS.postprocess, title: "Post Process", position: { referencePanel: "assets", direction: "within" } },
  polyhaven: { icon: PANEL_ICONS.polyhaven, title: "Poly Haven", position: { referencePanel: "assets", direction: "within" } },
  ambientcg: { icon: PANEL_ICONS.ambientcg, title: "AmbientCG", position: { referencePanel: "assets", direction: "within" } },
  sketchfab: { icon: PANEL_ICONS.sketchfab, title: "Sketchfab", position: { referencePanel: "assets", direction: "within" } },
  polypizza: { icon: PANEL_ICONS.polypizza, title: "Poly Pizza", position: { referencePanel: "assets", direction: "within" } },
  kaykit: { icon: PANEL_ICONS.kaykit, title: "KayKit", position: { referencePanel: "assets", direction: "within" } },
  fab: { icon: PANEL_ICONS.fab, title: "Fab", position: { referencePanel: "assets", direction: "within" } },
  itchio: { icon: PANEL_ICONS.itchio, title: "itch.io", position: { referencePanel: "assets", direction: "within" } },
  audioLibrary: { icon: PANEL_ICONS.audioLibrary, title: "Audio Library", position: { referencePanel: "assets", direction: "within" } },
  // Docks with the Assets strip for the same reason the Texture Editor does:
  // track heads plus waveform lanes need width, not the 320px Inspector column.
  audioEditor: { icon: PANEL_ICONS.audioEditor, title: "Audio Editor", position: { referencePanel: "assets", direction: "within" }, initialHeight: 420 },
  // Docks with the Assets strip like the other wide authoring surfaces: a
  // paint canvas plus a tool column plus a layer column does not fit the
  // 320px Inspector column, and the canvas is the point of the panel.
  textureEditor: { icon: PANEL_ICONS.textureEditor, title: "Texture Editor", position: { referencePanel: "assets", direction: "within" }, initialHeight: 420 },
  // Docks with the Assets strip: a terminal wants width for wrapped output and
  // the CLIs draw full-width boxes, so the 320px Inspector column would render
  // Claude unusable.
  performance: { icon: PANEL_ICONS.performance, title: "Performance", position: { referencePanel: "assets", direction: "within" } },
  terminal: { icon: PANEL_ICONS.terminal, title: "Terminal", position: { referencePanel: "assets", direction: "within" } },
  // Docks with the Inspector column: it's a narrow status/settings surface,
  // read at a glance rather than worked in.
  mcp: { icon: PANEL_ICONS.mcp, title: "Assistant (MCP)", position: { referencePanel: "inspector", direction: "within" } },
  // Same column as the Assistant panel it runs through — opened by context-menu
  // AI actions, not something a user finds by browsing first.
  ai: { icon: PANEL_ICONS.ai, title: "AI", position: { referencePanel: "inspector", direction: "within" } },
  // Docks with the Assets strip: the changed-files list and the diff have to be
  // side by side (see GitPanel's header), and a diff in the 320px Inspector
  // column wraps every line into uselessness.
  git: { icon: PANEL_ICONS.git, title: "Source Control", position: { referencePanel: "assets", direction: "within" }, initialHeight: 420 },
  // Code wants the viewport's real estate, not the Assets strip: you read a
  // script down the page, and a 200px-tall pane shows eight lines of it.
  code: { icon: PANEL_ICONS.code, title: "Code", position: { referencePanel: "viewport", direction: "within" } },
  // A font browser is a grid of specimens — same wide strip as the other
  // asset-library panels it sits alongside.
  fontLibrary: { icon: PANEL_ICONS.fontLibrary, title: "Fonts", position: { referencePanel: "assets", direction: "within" } },
};

/** The launcher's five families, in the order they are shown. Every id in
 *  PANEL_SPECS appears exactly once. */
export const PANEL_FAMILIES = [
  { title: "Scene", ids: ["viewport", "game", "hierarchy", "inspector", "assets", "console"] },
  { title: "Authoring", ids: ["shaderGraph", "particles", "vfx", "animator", "timeline", "postprocess", "geometryEditor", "textureEditor", "eventGraph", "code"] },
  { title: "Libraries", ids: ["polyhaven", "ambientcg", "sketchfab", "polypizza", "kaykit", "fab", "itchio", "audioLibrary", "fontLibrary"] },
  { title: "Project", ids: ["sceneSettings", "projectSettings", "build", "modules", "input", "events"] },
  { title: "Tools", ids: ["performance", "audioEditor", "terminal", "git", "mcp", "ai"] },
];
