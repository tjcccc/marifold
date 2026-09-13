import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './SourceCitation.module.css';

/** Preview supplied citation metadata only; never fetch a site on hover. */
export function SourceCitation({ href, title }: { href: string; title: string }) {
  const anchor = useRef<HTMLAnchorElement>(null);
  const popup = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  let domain: string;
  try { domain = new URL(href).hostname.replace(/^www\./, ''); }
  catch { domain = title; }

  function show() {
    clearTimeout(timer.current);
    setOpen(true);
  }
  function hide() {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), 120);
  }
  useEffect(() => () => clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const a = anchor.current?.getBoundingClientRect();
      const p = popup.current?.getBoundingClientRect();
      if (!a || !p) return;
      setPosition({
        left: Math.max(12, Math.min(a.left, window.innerWidth - p.width - 12)),
        top: a.bottom + p.height + 8 < window.innerHeight
          ? a.bottom + 8 : Math.max(12, a.top - p.height - 8),
      });
    }
    function dismiss(event: KeyboardEvent) { if (event.key === 'Escape') setOpen(false); }
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    window.addEventListener('keydown', dismiss);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('keydown', dismiss);
    };
  }, [open]);

  return <>
    <a ref={anchor} href={href} target="_blank" rel="noreferrer noopener"
      className={styles.tag} aria-label={title || domain} aria-describedby={open ? id : undefined}
      onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={() => setOpen(false)}>
      {domain}
    </a>
    {open && createPortal(
      <span ref={popup} id={id} role="tooltip" className={styles.preview} style={position}
        onMouseEnter={show} onMouseLeave={hide}>
        <span className={styles.domain}>{domain}</span>
        <strong className={styles.title}>{title || domain}</strong>
        <span className={styles.url}>{href}</span>
      </span>, document.body)}
  </>;
}
