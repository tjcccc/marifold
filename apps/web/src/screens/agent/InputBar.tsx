import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SkillHint } from '../../api/misc';
import { ImagePreviewDialog } from '../../components/ImagePreviewDialog';
import type { PreviewImage } from '../../components/ImagePreviewDialog';
import type { OfficeFileKind, PreparedAttachment } from '../../lib/attachments';
import { menuQuery, splitLeading, WEB_COMMANDS } from '../../lib/commandSyntax';
import type { Suggestion } from '../../lib/commandSyntax';
import styles from './InputBar.module.css';

const MAX_SUGGESTIONS = 8;

export interface InputBarProps {
  /** Stable profile/session key used to restore unsent text after navigation. */
  draftKey?: string;
  /** True while a run is active: submissions steer instead of starting a turn. */
  steering: boolean;
  /** True while the current chat or agent response can be stopped. */
  responding: boolean;
  disabled?: boolean;
  think: boolean;
  onToggleThink: () => void;
  modelOptions: string[];
  /** undefined = Auto (profile/config default). */
  modelChoice?: string;
  onSelectModel: (choice?: string) => void;
  attachments?: PreparedAttachment[];
  onAttachFiles?: (files: File[]) => void;
  onRemoveAttachment?: (index: number) => void;
  /** Available skills for the `$` autocomplete (from GET /v1/skills). */
  skills?: SkillHint[];
  onSubmit: (text: string) => void;
  onStop: () => void;
}

/** The composer (design 1a): attach +, textarea, Think pill, model chip,
 * marigold send. `$skill` is highlighted inline and autocompleted from a
 * keyboard-navigable menu; files arrive via the picker or paste. */
export function InputBar(props: InputBarProps) {
  const [text, setText] = useState(() => readDraft(props.draftKey));
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [caret, setCaret] = useState(0);
  const [previewIndex, setPreviewIndex] = useState<number>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeItemRef = useRef<HTMLLIElement>(null);
  const completionCaretRef = useRef<number | undefined>(undefined);
  const composingRef = useRef(false);
  const attachments = props.attachments ?? [];
  const previewImages: PreviewImage[] = attachments.flatMap(attachment =>
    attachment.kind === 'image'
      ? [{ src: `data:${attachment.mediaType};base64,${attachment.data}`, alt: attachment.name }]
      : [],
  );
  // Steering rides an active run — attachments can't join mid-task.
  const canAttach = props.onAttachFiles !== undefined && !props.steering;

  useEffect(() => {
    const restored = readDraft(props.draftKey);
    setText(restored);
    setCaret(restored.length);
    setDismissed(false);
  }, [props.draftKey]);

  const menu = menuQuery(text, caret);
  const source: Suggestion[] = menu?.sigil === '/' ? WEB_COMMANDS : (props.skills ?? []);
  const matches = menu ? source.filter(item => item.name.startsWith(menu.query)).slice(0, MAX_SUGGESTIONS) : [];
  const menuOpen = focused && !dismissed && matches.length > 0;
  const active = Math.min(activeIndex, Math.max(0, matches.length - 1));
  const sigil = menu?.sigil ?? '$';

  // Keep the highlighted suggestion scrolled into view as the arrows move it.
  useEffect(() => {
    if (menuOpen) activeItemRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [active, menuOpen]);

  // Pasting a long block can make the native textarea scroll to the caret
  // before React has committed the same text into the visible mirror. Sync
  // again after that commit (and once on the next frame for WebKit's delayed
  // caret scrolling), otherwise newly typed tail characters look invisible.
  useLayoutEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    autosize(node);
    return syncHighlightAfterLayout(node);
  }, [text]);

  // A controlled textarea may preserve its old selection offset when React
  // replaces a short query with a longer completion. Place the caret after the
  // completed token once that value has reached the DOM.
  useLayoutEffect(() => {
    const caret = completionCaretRef.current;
    if (caret === undefined) return;
    completionCaretRef.current = undefined;
    const node = textareaRef.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(caret, caret);
    autosize(node);
    return syncHighlightAfterLayout(node);
  }, [text]);

  function submit(): void {
    const value = text.trim();
    if (!value || props.disabled) return;
    props.onSubmit(value);
    setText('');
    removeDraft(props.draftKey);
    setCaret(0);
    setDismissed(false);
    const node = textareaRef.current;
    if (node) node.style.height = 'auto';
  }

  function complete(item: Suggestion): void {
    const head = `${sigil}${item.name}`;
    const suffix = menu ? text.slice(menu.end) : '';
    const separator = suffix.length === 0 ? ' ' : '';
    const completed = `${head}${separator}${suffix}`;
    const completedCaret = head.length + (separator.length > 0 || suffix.length > 0 ? 1 : 0);
    completionCaretRef.current = completedCaret;
    setText(completed);
    writeDraft(props.draftKey, completed);
    setCaret(completedCaret);
    setActiveIndex(0);
    setDismissed(false);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    // Enter commits an active IME composition. It must never also submit the
    // half-composed text (keyCode 229 covers older WebKit behavior).
    if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (menuOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex(index => (index + 1) % matches.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex(index => (index - 1 + matches.length) % matches.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        complete(matches[active]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  function onPaste(event: React.ClipboardEvent<HTMLTextAreaElement>): void {
    if (!canAttach) return;
    const files = [...event.clipboardData.files];
    if (files.length === 0) return;
    event.preventDefault();
    props.onAttachFiles?.(files);
  }

  function autosize(node: HTMLTextAreaElement): void {
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 160)}px`;
  }

  function syncHighlightScroll(node: HTMLTextAreaElement): void {
    const highlight = highlightRef.current;
    if (!highlight) return;
    highlight.scrollTop = node.scrollTop;
    highlight.scrollLeft = node.scrollLeft;
  }

  function syncHighlightAfterLayout(node: HTMLTextAreaElement): (() => void) | undefined {
    syncHighlightScroll(node);
    if (typeof window.requestAnimationFrame !== 'function') return undefined;
    const frame = window.requestAnimationFrame(() => syncHighlightScroll(node));
    return () => window.cancelAnimationFrame(frame);
  }

  const { token, rest } = splitLeading(text);
  // A div does not allocate the textarea's final empty line for a trailing
  // newline. The zero-width sentinel keeps both scroll heights identical.
  const trailingLineSentinel = text.endsWith('\n') ? '\u200b' : null;

  return (
    <div className={styles.wrap}>
      {attachments.length > 0 ? (
        <div className={styles.chips}>
          {attachments.map((attachment, index) => (
            <span
              key={`${attachment.name}_${index}`}
              className={styles.chip}
              title={attachment.kind === 'image' && attachment.optimized
                ? `${formatBytes(attachment.originalSize ?? attachment.size)} → ${formatBytes(attachment.size)}`
                : attachment.kind === 'text' && attachment.officeKind
                  ? `${officeKindLabel(attachment.officeKind)} · ${formatBytes(attachment.size)} extracted text${attachment.truncated ? ' · truncated' : ''}`
                  : attachment.kind === 'file'
                    ? `${attachment.mediaType} · ${formatBytes(attachment.size)}`
                    : undefined}
            >
              {attachment.kind === 'image' ? (
                <button
                  type="button"
                  className={styles.chipPreviewButton}
                  aria-label={`Preview ${attachment.name}`}
                  onClick={() => setPreviewIndex(
                    attachments
                      .slice(0, index + 1)
                      .filter(candidate => candidate.kind === 'image')
                      .length - 1,
                  )}
                >
                  <img
                    className={styles.chipThumb}
                    src={`data:${attachment.mediaType};base64,${attachment.data}`}
                    alt={attachment.name}
                  />
                </button>
              ) : (
                <span
                  className={attachment.kind === 'text' && attachment.officeKind ? styles.officeFileIcon : undefined}
                  aria-hidden
                >
                  {officeKindGlyph(attachment.kind === 'text' ? attachment.officeKind : undefined)}
                </span>
              )}
              <span className={styles.chipName}>
                {attachment.name}{attachment.kind === 'image' && attachment.optimized ? ` · ${formatBytes(attachment.size)}` : ''}
              </span>
              <button
                className={styles.chipRemove}
                aria-label={`Remove ${attachment.name}`}
                onClick={() => props.onRemoveAttachment?.(index)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {/* Two rows (ChatGPT-style): the textarea spans the full width; attach +
          Think/model/send sit on their own row below — so a tall input never
          leaves a dead column above the inline controls. */}
      <div className={styles.bar}>
        <div className={styles.inputWrap}>
          {menuOpen ? (
            <ul className={styles.menu} role="listbox" aria-label={sigil === '/' ? 'Commands' : 'Skills'}>
              {matches.map((item, index) => (
                <li
                  key={item.name}
                  ref={index === active ? activeItemRef : undefined}
                  role="option"
                  aria-selected={index === active}
                  className={index === active ? styles.menuItemActive : styles.menuItem}
                  onMouseDown={event => {
                    event.preventDefault(); // keep textarea focus through the click
                    complete(item);
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                >
                  <span className={styles.menuName}>{item.usage}</span>
                  {item.description ? <span className={styles.menuDesc}>{item.description}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {/* Highlight layer behind the transparent textarea: same text, with the
              leading $skill token colored. */}
          <div className={styles.highlight} ref={highlightRef} aria-hidden>
            {token ? (
              <>
                <span className={styles.skillToken}>{token}</span>
                {rest}
                {trailingLineSentinel}
              </>
            ) : (
              <>{text}{trailingLineSentinel}</>
            )}
          </div>
          <textarea
            ref={textareaRef}
            className={styles.input}
            rows={1}
            value={text}
            placeholder={
              props.steering ? 'Reply — the run keeps going; guidance is picked up mid-task' : 'Message the agent…'
            }
            onChange={event => {
              const next = event.target.value;
              setText(next);
              writeDraft(props.draftKey, next);
              setCaret(event.target.selectionStart ?? next.length);
              setDismissed(false);
              setActiveIndex(0);
            }}
            onScroll={event => {
              syncHighlightScroll(event.currentTarget);
            }}
            onKeyDown={onKeyDown}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
            onPaste={onPaste}
            onFocus={event => {
              setFocused(true);
              setCaret(event.currentTarget.selectionStart ?? text.length);
            }}
            onSelect={event => setCaret(event.currentTarget.selectionStart ?? text.length)}
            onBlur={() => setFocused(false)}
          />
        </div>
        <div className={styles.bottomRow}>
          {canAttach ? (
            <>
              <button
                className={styles.attach}
                title="Attach files"
                aria-label="Attach files"
                onClick={() => fileInputRef.current?.click()}
              >
                +
              </button>
              <input
                ref={fileInputRef}
                className={styles.fileInput}
                type="file"
                multiple
                onChange={event => {
                  const files = [...(event.target.files ?? [])];
                  if (files.length > 0) props.onAttachFiles?.(files);
                  event.target.value = '';
                }}
              />
            </>
          ) : null}
          <div className={styles.controls}>
            <button
              className={props.think ? styles.pillActive : styles.pill}
              title="Thinking mode"
              onClick={props.onToggleThink}
            >
              Think
            </button>
            <ModelChip options={props.modelOptions} choice={props.modelChoice} onSelect={props.onSelectModel} />
            {props.responding ? (
              <button
                className={styles.stop}
                aria-label="Stop response"
                title="Stop response"
                onClick={props.onStop}
              >
                <span className={styles.stopIcon} aria-hidden />
              </button>
            ) : (
              <button
                className={styles.send}
                disabled={props.disabled || text.trim().length === 0}
                aria-label={props.steering ? 'Send guidance' : 'Send'}
                onClick={submit}
              >
                ↑
              </button>
            )}
          </div>
        </div>
      </div>
      {previewIndex !== undefined ? (
        <ImagePreviewDialog
          images={previewImages}
          initialIndex={previewIndex}
          onClose={() => setPreviewIndex(undefined)}
        />
      ) : null}
    </div>
  );
}

const DRAFT_PREFIX = 'marifold.composer-draft.';

function readDraft(key?: string): string {
  if (!key) return '';
  try {
    return localStorage.getItem(`${DRAFT_PREFIX}${key}`) ?? '';
  } catch {
    return '';
  }
}

function writeDraft(key: string | undefined, value: string): void {
  if (!key) return;
  try {
    if (value) localStorage.setItem(`${DRAFT_PREFIX}${key}`, value);
    else localStorage.removeItem(`${DRAFT_PREFIX}${key}`);
  } catch {
    // Browsers may deny storage in private/embedded contexts; drafts then stay
    // available for the lifetime of the mounted composer.
  }
}

function removeDraft(key?: string): void {
  writeDraft(key, '');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function officeKindGlyph(kind: OfficeFileKind | undefined): string {
  if (kind === 'word') return 'W';
  if (kind === 'spreadsheet') return 'X';
  if (kind === 'presentation') return 'P';
  return '📄';
}

function officeKindLabel(kind: OfficeFileKind): string {
  if (kind === 'word') return 'Word document';
  if (kind === 'spreadsheet') return 'Excel workbook';
  return 'PowerPoint presentation';
}

function ModelChip({
  options,
  choice,
  onSelect,
}: {
  options: string[];
  choice?: string;
  onSelect: (choice?: string) => void;
}) {
  const AUTO = '__auto__';
  return (
    <label className={styles.modelChip} title="Model for this message">
      <span>{choice ?? 'Auto'}</span>
      <span aria-hidden>⌄</span>
      <select
        className={styles.modelSelect}
        value={choice ?? AUTO}
        onChange={event => onSelect(event.target.value === AUTO ? undefined : event.target.value)}
      >
        <option value={AUTO}>Auto — profile default</option>
        {options.map(option => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}
