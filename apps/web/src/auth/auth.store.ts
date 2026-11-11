import { create } from 'zustand';

export type AuthMode = 'disabled' | 'required';

interface AuthState {
  mode: AuthMode;
  /** Becomes `authenticated` once the Identity phase (Phase 2) provides a session. */
  status: 'anonymous' | 'authenticated';
}

export const useAuthStore = create<AuthState>(() => ({
  mode: import.meta.env.VITE_AUTH_MODE === 'required' ? 'required' : 'disabled',
  status: 'anonymous',
}));
