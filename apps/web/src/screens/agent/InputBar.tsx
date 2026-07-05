import { useRef, useState } from 'react';
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
  onSubmit: (text: string) => void;
}

/** The composer (design 1a): textarea, Think pill, model chip, marigold send. */
export function InputBar(props: InputBarProps) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  function autosize(node: HTMLTextAreaElement): void {
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 160)}px`;
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.bar}>
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
