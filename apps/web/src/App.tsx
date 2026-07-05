import { useState } from 'react';
import type { AppView } from './components/TopNav';
import { TopNav } from './components/TopNav';
import { useTheme } from './theme/theme';
import styles from './App.module.css';

/** Root shell: toolbar + the active view. Screens land in later steps; the
 * scaffold renders placeholders so the shell/theme are verifiable early. */
export function App() {
  const [view, setView] = useState<AppView>('agent');
  const [theme, setTheme] = useTheme();

  return (
    <div className={styles.shell}>
      <TopNav view={view} onViewChange={setView} theme={theme} onThemeChange={setTheme} />
      <main className={styles.content}>
        <Placeholder view={view} />
      </main>
    </div>
  );
}

function Placeholder({ view }: { view: AppView }) {
  return (
    <div className={styles.placeholder}>
      <div className={styles.placeholderTitle}>{view}</div>
      <div className={styles.placeholderHint}>Coming together — scaffold build.</div>
    </div>
  );
}
