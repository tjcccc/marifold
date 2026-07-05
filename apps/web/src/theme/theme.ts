import { useCallback, useState } from 'react';

export type ThemePreference = 'auto' | 'light' | 'dark';

const STORAGE_KEY = 'marifold.theme';
const PREFERENCES: ThemePreference[] = ['auto', 'light', 'dark'];

export function loadThemePreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'auto') return stored;
  } catch {
    // Storage unavailable (private mode etc.) — fall through to auto.
  }
  return 'auto';
}

/** `auto` removes the attribute so tokens.css follows the OS color scheme. */
export function applyThemePreference(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', preference);
  try {
    window.localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Non-persistent is fine; the in-page preference still applies.
  }
}

export function nextThemePreference(current: ThemePreference): ThemePreference {
  return PREFERENCES[(PREFERENCES.indexOf(current) + 1) % PREFERENCES.length];
}

export function useTheme(): [ThemePreference, (preference: ThemePreference) => void] {
  const [preference, setPreference] = useState<ThemePreference>(() => {
    const initial = loadThemePreference();
    applyThemePreference(initial);
    return initial;
  });
  const update = useCallback((next: ThemePreference) => {
    applyThemePreference(next);
    setPreference(next);
  }, []);
  return [preference, update];
}
