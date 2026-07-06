import { useRef, useState } from 'react';
import type { PreparedAttachment } from '../../lib/attachments';
import styles from './InputBar.module.css';

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
  onSubmit: (text: string) => void;
}

/** The composer (design 1a): attach +, textarea, Think pill, model chip,
 * marigold send. Files arrive via the picker or paste; drops land on the
 * whole thread pane (AgentScreen). */
export function InputBar(props: InputBarProps) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachments = props.attachments ?? [];
  // Steering rides an active run — attachments can't join mid-task.
  const canAttach = props.onAttachFiles !== undefined && !props.steering;

  function submit(): void {
    const value = text.trim();
    if (!value || props.disabled) return;
    props.onSubmit(value);
    setText('');
    const node = textareaRef.current;
    if (node) node.style.height = 'auto';
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
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
            autosize(event.target);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
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
