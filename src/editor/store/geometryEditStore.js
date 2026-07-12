import { create } from "zustand";

export const useGeometryEditStore = create((set) => ({
  entityId: null,
  enter(entityId) { set({ entityId }); },
  exit() { set({ entityId: null }); },
}));
