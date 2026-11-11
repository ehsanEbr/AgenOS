import { create } from 'zustand';

/** Client-only UI state. Server data belongs in TanStack Query, not here. */
interface UiState {
  siderCollapsed: boolean;
  setSiderCollapsed: (collapsed: boolean) => void;
}

export const useUiStore = create<UiState>((set) => ({
  siderCollapsed: false,
  setSiderCollapsed: (siderCollapsed) => set({ siderCollapsed }),
}));
