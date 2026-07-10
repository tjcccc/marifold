import { useRef, useState } from 'react';
import type { SkillHint } from '../../api/misc';
import type { PreparedAttachment } from '../../lib/attachments';
import { skillQuery, splitLeadingSkill } from '../../lib/commandSyntax';
import styles from './InputBar.module.css';

const MAX_SUGGESTIONS = 8;

export interface InputBarProps {
  /** True while a run is active: submissions steer instead of starting a turn. */
  steering: boolean;
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
}

/** The composer (design 1a): attach +, textarea, Think pill, model chip,
 * marigold send. `$skill` is highlighted inline and autocompleted from a
 * keyboard-navigable menu; files arrive via the picker or paste. */
export function InputBar(props: InputBarProps) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachments = props.attachments ?? [];
  // Steering rides an active run — attachments can't join mid-task.
  const canAttach = props.onAttachFiles !== undefined && !props.steering;

  const query = skillQuery(text);
  const matches = query !== undefined
    ? (props.skills ?? []).filter(skill => skill.name.startsWith(query)).slice(0, MAX_SUGGESTIONS)
    : [];
  const menuOpen = focused && !dismissed && matches.length > 0;
  const active = Math.min(activeIndex, Math.max(0, matches.length - 1));

  function submit(): void {
    const value = text.trim();
    if (!value || props.disabled) return;
    props.onSubmit(value);
    setText('');
    setDismissed(false);
    const node = textareaRef.current;
    if (node) node.style.height = 'auto';
  }

  function complete(skill: SkillHint): void {
    setText(`$${skill.name} `);
    setActiveIndex(0);
    setDismissed(false);
    const node = textareaRef.current;
    if (node) {
      node.focus();
      requestAnimationFrame(() => autosize(node));
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
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

  const { token, rest } = splitLeadingSkill(text);

  return (
    <div className={styles.wrap}>
      {attachments.length > 0 ? (
        <div className={styles.chips}>
          {attachments.map((attachment, index) => (
            <span key={`${attachment.name}_${index}`} className={styles.chip}>
              {attachment.kind === 'image' ? (
                <img
                  className={styles.chipThumb}
                  src={`data:${attachment.mediaType};base64,${attachment.data}`}
                  alt={attachment.name}
                />
              ) : (
                <span aria-hidden>📄</span>
              )}
              <span className={styles.chipName}>{attachment.name}</span>
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
      <div className={styles.bar}>
        {canAttach ? (
          <>
            <button
              className={styles.attach}
              title="Attach files or images"
              aria-label="Attach files or images"
              onClick={() => fileInputRef.current?.click()}
            >
              +
            </button>
            <input
              ref={fileInputRef}
              className={styles.fileInput}
              type="file"
              multiple
              accept="image/png,image/jpeg,image/webp,image/gif,text/*,.md,.json,.yaml,.yml,.toml,.csv,.ts,.tsx,.js,.jsx,.py,.sh,.log,.xml,.html,.css,.sql"
              onChange={event => {
                const files = [...(event.target.files ?? [])];
                if (files.length > 0) props.onAttachFiles?.(files);
                event.target.value = '';
              }}
            />
          </>
        ) : null}
        <div className={styles.inputWrap}>
          {menuOpen ? (
            <ul className={styles.menu} role="listbox" aria-label="Skills">
              {matches.map((skill, index) => (
                <li
                  key={skill.name}
                  role="option"
                  aria-selected={index === active}
                  className={index === active ? styles.menuItemActive : styles.menuItem}
                  onMouseDown={event => {
                    event.preventDefault(); // keep textarea focus through the click
                    complete(skill);
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                >
                  <span className={styles.menuName}>{skill.usage}</span>
                  {skill.description ? <span className={styles.menuDesc}>{skill.description}</span> : null}
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
              </>
            ) : (
              text
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
              setText(event.target.value);
              setDismissed(false);
              setActiveIndex(0);
              autosize(event.target);
            }}
            onScroll={event => {
              if (highlightRef.current) highlightRef.current.scrollTop = event.currentTarget.scrollTop;
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
          />
        </div>
        <div className={styles.controls}>
          <button
            className={props.think ? styles.pillActive : styles.pill}
            title="Thinking mode"
            onClick={props.onToggleThink}
          >
            Think
          </button>
          <ModelChip options={props.modelOptions} choice={props.modelChoice} onSelect={props.onSelectModel} />
          <button
            className={styles.send}
            disabled={props.disabled || text.trim().length === 0}
            aria-label={props.steering ? 'Send guidance' : 'Send'}
            onClick={submit}
          >
            ↑
          </button>
        </div>
      </div>
    </div>
  );
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
