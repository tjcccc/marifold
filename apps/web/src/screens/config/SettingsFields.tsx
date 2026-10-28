import styles from './SystemPages.module.css';

/** On/Off segmented control for a boolean setting. */
export function Toggle({
  label,
  value,
  busy,
  onChange,
}: {
  label: string;
  value: boolean;
  busy: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className={styles.segmented} role="radiogroup" aria-label={label}>
      {[true, false].map(option => (
        <button
          key={String(option)}
          type="button"
          role="radio"
          aria-checked={value === option}
          className={value === option ? styles.segmentActive : styles.segment}
          disabled={busy}
          onClick={() => onChange(option)}
        >
          {option ? 'On' : 'Off'}
        </button>
      ))}
    </div>
  );
}

/** A text setting with a Save button that appears once it changes. */
export function EditableText({
  id,
  label,
  value,
  changed,
  placeholder,
  busy,
  onChange,
  onSave,
}: {
  id: string;
  label: string;
  value: string;
  changed: boolean;
  placeholder: string;
  busy: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  return (
    <div className={styles.fieldRow}>
      <label className={styles.fieldLabel} htmlFor={id}>{label}</label>
      <div className={styles.fieldEdit}>
        <input
          id={id}
          className={styles.input}
          value={value}
          placeholder={placeholder}
          onChange={event => onChange(event.target.value)}
        />
        {changed ? (
          <button className={styles.saveAction} type="button" disabled={busy} onClick={onSave}>Save</button>
        ) : null}
      </div>
    </div>
  );
}
