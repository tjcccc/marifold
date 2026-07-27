import type { ReactNode } from 'react';
import { SidebarBrand } from '../../components/SidebarChrome';
import styles from './ProfileSidebar.module.css';

export interface WorkspaceSidebarProps {
  ariaLabel: string;
  children: ReactNode;
  footer?: ReactNode;
  showBrand?: boolean;
}

/** Persistent primary-sidebar shell. Only its catalog body changes between
 * Agent and Apps, so the brand, footer, and resizable frame keep their state. */
export function WorkspaceSidebar({
  ariaLabel,
  children,
  footer,
  showBrand = false,
}: WorkspaceSidebarProps) {
  return (
    <nav className={styles.pane} aria-label={ariaLabel}>
      {showBrand ? <SidebarBrand prominent /> : null}
      {children}
      {footer}
    </nav>
  );
}
