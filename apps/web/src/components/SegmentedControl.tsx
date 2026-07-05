import styles from './SegmentedControl.module.css';

export interface SegmentOption<Id extends string> {
  id: Id;
  label: string;
}

export interface SegmentedControlProps<Id extends string> {
  options: ReadonlyArray<SegmentOption<Id>>;
  value: Id;
  onChange: (id: Id) => void;
  'aria-label'?: string;
}

/** macOS-style segmented control (the design's toolbar view switch). */
export function SegmentedControl<Id extends string>(props: SegmentedControlProps<Id>) {
  return (
    <div className={styles.control} role="tablist" aria-label={props['aria-label']}>
      {props.options.map(option => (
        <button
          key={option.id}
          role="tab"
          aria-selected={option.id === props.value}
          className={option.id === props.value ? styles.selected : styles.segment}
          onClick={() => props.onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
