import {
  FolderPlus,
  FolderOpen,
  Box,
  Sparkles,
  Zap,
  Boxes,
  Layers,
  ArrowRight,
  Clock,
  FileBox,
} from "lucide-react";
import { useProjectStore, basename } from "./store/projectStore.js";

function LogoMark() {
  return (
    <svg width="42" height="42" viewBox="0 0 42 42" fill="none" aria-hidden>
      <defs>
        <linearGradient id="te-mark" x1="0" y1="0" x2="42" y2="42" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#7dd3fc" />
          <stop offset="55%" stopColor="#0a84ff" />
          <stop offset="100%" stopColor="#a78bfa" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="40" height="40" rx="11" fill="url(#te-mark)" />
      <path
        d="M21 10 L33 33 L24.5 33 L21 26 L17.5 33 L9 33 Z"
        fill="white"
        fillOpacity="0.96"
      />
      <circle cx="21" cy="20" r="2.4" fill="url(#te-mark)" />
    </svg>
  );
}

function FeatureChip({ icon: Icon, label, sub }) {
  return (
    <li className="hub-feature">
      <span className="hub-feature-icon">
        <Icon size={16} strokeWidth={2} />
      </span>
      <span className="hub-feature-text">
        <span className="hub-feature-label">{label}</span>
        {sub && <span className="hub-feature-sub">{sub}</span>}
      </span>
    </li>
  );
}

function HubButton({ icon: Icon, title, sub, onClick, accent }) {
  return (
    <button className={`hub-action${accent ? " hub-action-accent" : ""}`} onClick={onClick}>
      <span className="hub-action-icon">
        <Icon size={18} strokeWidth={2} />
      </span>
      <span className="hub-action-text">
        <span className="hub-action-title">{title}</span>
        {sub && <span className="hub-action-sub">{sub}</span>}
      </span>
      <span className="hub-action-chevron">
        <ArrowRight size={16} strokeWidth={2} />
      </span>
    </button>
  );
}

function RecentRow({ path, onOpen }) {
  const parent = path.replace(/[\\/][^\\/]+$/, "");
  return (
    <button className="hub-recent" onClick={() => onOpen(path)} title={path}>
      <span className="hub-recent-thumb">
        <FileBox size={20} strokeWidth={1.7} />
      </span>
      <span className="hub-recent-meta">
        <span className="hub-recent-name">{basename(path)}</span>
        <span className="hub-recent-path">{parent}</span>
      </span>
      <span className="hub-recent-open">
        Open <ArrowRight size={13} strokeWidth={2.2} />
      </span>
    </button>
  );
}

export function ProjectHub() {
  const { recent, createProject, openFolder, openProject, skipHub } = useProjectStore();

  return (
    <div className="hub-shell">
      <div className="hub-glow" aria-hidden />

      <aside className="hub-aside">
        <div className="hub-brand">
          <LogoMark />
          <div className="hub-brand-text">
            <div className="hub-brand-name">Three Engine</div>
            <div className="hub-brand-tag">WebGPU game editor</div>
          </div>
        </div>

        <ul className="hub-features">
          <FeatureChip icon={Zap} label="WebGPU-first" sub="WebGL2 fallback" />
          <FeatureChip icon={Boxes} label="ECS scene graph" sub="Entity + components" />
          <FeatureChip icon={Layers} label="Node graphs" sub="Shaders & particles" />
          <FeatureChip icon={Sparkles} label="Hot-reload scripts" sub="TypeScript decorators" />
        </ul>

        <div className="hub-aside-foot">
          <span>v0.1.0</span>
          <span className="hub-dot" />
          <span>Tauri 2</span>
          <span className="hub-dot" />
          <span>three r185</span>
        </div>
      </aside>

      <main className="hub-main">
        <header className="hub-hero">
          <div className="hub-eyebrow">
            <Box size={13} strokeWidth={2.2} />
            <span>Project Hub</span>
          </div>
          <h1 className="hub-title">Start something new.</h1>
          <p className="hub-subtitle">
            Create a fresh project, open one from disk, or jump back into a recent workspace.
          </p>
        </header>

        <section className="hub-card hub-card-actions">
          <HubButton
            icon={FolderPlus}
            title="New Project"
            sub="Pick a folder, scaffold project.json, and open it"
            onClick={createProject}
            accent
          />
          <HubButton
            icon={FolderOpen}
            title="Open Project"
            sub="Open any folder that contains a project.json"
            onClick={openFolder}
          />
          <HubButton
            icon={Box}
            title="Skip the project"
            sub="Jump straight into the editor with no project open"
            onClick={skipHub}
          />
        </section>

        {recent.length > 0 && (
          <section className="hub-card hub-card-recent">
            <header className="hub-card-head">
              <span className="hub-card-head-title">
                <Clock size={13} strokeWidth={2.2} />
                Recent
              </span>
              <span className="hub-card-head-count">{recent.length}</span>
            </header>
            <div className="hub-recent-list">
              {recent.map((path) => (
                <RecentRow key={path} path={path} onOpen={openProject} />
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}