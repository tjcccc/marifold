import styles from './SidebarLoading.module.css';

export function SidebarLoading({ label }: { label: string }) {
  return <div className={styles.loading} role="status">
    <span className={styles.spinner} aria-hidden="true" />
    {label}
  </div>;
}
