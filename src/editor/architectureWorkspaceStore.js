import { create } from "zustand";

// UI state only. Placement and scene commands remain owned by their tools.
export const useArchitectureWorkspace = create(() => ({ open: false, mode: "sculpt", parentId: null, request: 0 }));

export function openArchitectureWorkspace({ mode = "sculpt", parentId = null } = {}) {
  useArchitectureWorkspace.setState((state) => ({ open: true, mode, parentId, request: state.request + 1 }));
}

export function closeArchitectureWorkspace() { useArchitectureWorkspace.setState({ open: false }); }
