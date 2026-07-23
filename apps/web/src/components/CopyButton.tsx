import { useEffect, useRef, useState } from 'react';

export interface CopyButtonProps {
  text: string;
  label: string;
  className?: string;
}

/** Compact clipboard action with accessible copied/failed feedback. */
export function CopyButton({ text, label, className }: CopyButtonProps) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => {
    if (resetTimer.current !== undefined) clearTimeout(resetTimer.current);
  }, []);

  async function copy(): Promise<void> {
    try {
      await writeClipboardText(text);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
    if (resetTimer.current !== undefined) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setStatus('idle'), 1600);
  }

  const accessibleLabel = status === 'copied'
    ? 'Copied'
    : status === 'failed'
      ? 'Copy failed'
      : label;

  return (
    <button
      type="button"
      className={className}
      aria-label={accessibleLabel}
      title={accessibleLabel}
      onClick={() => void copy()}
    >
      {status === 'copied' ? <CheckGlyph /> : <CopyGlyph />}
    </button>
  );
}

async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  try {
    const copied = document.execCommand?.('copy') ?? false;
    if (!copied) throw new Error('Clipboard is unavailable.');
  } finally {
    textarea.remove();
  }
}

function CopyGlyph() {
  return (
    <svg width="17" height="17" viewBox="0 0 17 17" fill="none" aria-hidden focusable="false">
      <rect x="5.25" y="2.25" width="8.5" height="8.5" rx="1.75" stroke="currentColor" strokeWidth="1.4" />
      <path d="M11.25 11.5v1.25c0 .97-.78 1.75-1.75 1.75H4.25c-.97 0-1.75-.78-1.75-1.75V7.5c0-.97.78-1.75 1.75-1.75H5.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg width="17" height="17" viewBox="0 0 17 17" fill="none" aria-hidden focusable="false">
      <path d="m3.5 8.75 3.1 3.1 6.9-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
