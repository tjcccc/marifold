import { useLayoutEffect, useRef, useState } from 'react';
import type { SkillAppDefinition, SkillAppLayoutItem } from '../../api/types';
import type { PreparedAttachment } from '../../lib/attachments';
import { CopyButton } from '../../components/CopyButton';
import { Markdown as MarkdownView } from '../../components/Markdown';
import styles from './SkillAppLayout.module.css';
import { isOperationRunnable } from './skillAppHelpers';

// Renderers for a SkillApp's semantic layout: rows/columns, fields, buttons, attachments, Markdown, textareas, and downloads.

export function SkillLayoutItem({
  app,
  attachments,
  busy,
  item,
  locked,
  onAttachFiles,
  onOperation,
  onChange,
  onRemoveAttachment,
  path,
  ready,
  runningOutput,
  staleOutputs,
  values,
}: {
  app: SkillAppDefinition;
  attachments: Record<string, PreparedAttachment[]>;
  busy: boolean;
  item: SkillAppLayoutItem;
  locked: boolean;
  onAttachFiles: (name: string, files: File[]) => void;
  onOperation: (name: string) => void;
  onChange: (name: string, value: string) => void;
  onRemoveAttachment: (name: string, index: number) => void;
  path: string;
  ready: boolean;
  runningOutput?: string;
  staleOutputs: Set<string>;
  values: Record<string, string>;
}) {
  const value = item.bind ? values[item.bind] ?? '' : '';
  const containerClass = item.component === 'row'
    ? `${styles.row} ${item.responsive === 'stack' ? styles.stackResponsive : ''}`
    : styles.column;
  if (item.component === 'row' || item.component === 'column') {
    return (
      <div className={`${containerClass} ${styles[`gap_${item.gap ?? 'medium'}`]}`}>
        {item.children?.map((child, index) => (
          <div
            className={child.grow || child.component === 'spacer' ? styles.grow : undefined}
            key={`${child.component}-${index}`}
          >
            <SkillLayoutItem
              {...{
                app,
                attachments,
                busy,
                item: child,
                locked,
                onAttachFiles,
                onOperation,
                onChange,
                onRemoveAttachment,
                ready,
                runningOutput,
                staleOutputs,
                values,
              }}
              path={`${path}-${index}`}
            />
          </div>
        ))}
      </div>
    );
  }
  if (item.component === 'spacer') { return <span aria-hidden className={styles.spacer} />; }
  if (item.component === 'button') {
    const operation = item.trigger
      ? app.operations.find(candidate => candidate.name === item.trigger)
      : undefined;
    const runnable = operation
      ? isOperationRunnable(operation.requiredInputs, values)
      : false;
    const button = (
      <button
        className={item.emphasis === 'secondary' ? styles.secondaryButton : styles.primaryButton}
        disabled={busy || !ready || !item.trigger || !runnable}
        onClick={() => item.trigger && onOperation(item.trigger)}
        type="button"
      >
        {item.label}
      </button>
    );
    return item.alignToField ? (
      <div className={styles.fieldAlignedButton}>
        <span aria-hidden className={styles.fieldLabelSpacer} />
        {button}
      </div>
    ) : button;
  }
  if (!item.bind || !item.label) { return null; }
  const fieldLabel = (
    <span className={item.showLabel === false ? styles.visuallyHidden : styles.label}>{item.label}</span>
  );
  if (item.component === 'select') {
    return (
      <label className={styles.field}>
        {fieldLabel}
        <select disabled={locked || !ready} onChange={event => onChange(item.bind!, event.target.value)} value={value}>
          {item.options?.map(option => {
            const choice = typeof option === 'string' ? { label: option, value: option } : option;
            return <option key={choice.value} value={choice.value}>{choice.label}</option>;
          })}
        </select>
      </label>
    );
  }
  if (item.component === 'textarea') {
    return (
      <SkillTextarea
        {...{ item, locked, onChange, path, ready, value }}
        generating={item.bind === runningOutput}
        stale={staleOutputs.has(item.bind) && Boolean(value.trim())}
      />
    );
  }
  if (item.component === 'markdown') {
    return (
      <SkillMarkdown
        item={item}
        generating={item.bind === runningOutput}
        locked={locked}
        stale={staleOutputs.has(item.bind) && Boolean(value.trim())}
        value={value}
      />
    );
  }
  if (item.component === 'download') {
    return <SkillDownload generating={item.bind === runningOutput} item={item} locked={locked} value={value} />;
  }
  if (item.component === 'attachments') {
    return (
      <SkillAttachments
        attachments={attachments[item.bind] ?? []}
        busy={busy || !ready}
        item={item}
        onAttachFiles={files => onAttachFiles(item.bind!, files)}
        onRemove={index => onRemoveAttachment(item.bind!, index)}
        path={path}
      />
    );
  }
  return null;
}

export function SkillAttachments({
  attachments,
  busy,
  item,
  onAttachFiles,
  onRemove,
  path,
}: {
  attachments: PreparedAttachment[];
  busy: boolean;
  item: SkillAppLayoutItem;
  onAttachFiles: (files: File[]) => void;
  onRemove: (index: number) => void;
  path: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const inputId = `skillapp-${item.bind}-${path}`;

  function acceptFiles(files: FileList | File[]): void {
    if (!busy && files.length > 0) { onAttachFiles([...files]); }
  }

  return (
    <div className={styles.field}>
      <label className={item.showLabel === false ? styles.visuallyHidden : styles.label} htmlFor={inputId}>
        {item.label}
      </label>
      <div
        className={`${styles.attachmentZone} ${dragActive ? styles.attachmentZoneActive : ''}`}
        onDragEnter={event => {
          if (![...event.dataTransfer.types].includes('Files')) { return; }
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setDragActive(false); }
        }}
        onDragOver={event => {
          if (![...event.dataTransfer.types].includes('Files')) { return; }
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDrop={event => {
          event.preventDefault();
          setDragActive(false);
          acceptFiles(event.dataTransfer.files);
        }}
      >
        <button
          aria-label={attachments.length > 0 ? 'Add more attachments' : 'Choose attachments'}
          className={styles.attachmentPicker}
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          type="button"
        >
          {attachments.length === 0 ? (
            <span><strong>Choose files</strong> or drop them here</span>
          ) : null}
        </button>
        <input
          className={styles.fileInput}
          id={inputId}
          multiple
          onChange={event => {
            acceptFiles(event.target.files ?? []);
            event.target.value = '';
          }}
          ref={inputRef}
          type="file"
        />
        {attachments.length > 0 ? (
          <div className={styles.attachmentChips}>
            {attachments.map((attachment, index) => (
              <span className={styles.attachmentChip} key={`${attachment.name}-${index}`} title={attachment.name}>
                {attachment.kind === 'image' ? (
                  <img
                    alt=""
                    className={styles.attachmentThumbnail}
                    src={`data:${attachment.mediaType};base64,${attachment.data}`}
                  />
                ) : (
                  <span aria-hidden className={styles.attachmentFileIcon}>▤</span>
                )}
                <span className={styles.attachmentName}>{attachment.name}</span>
                <button
                  aria-label={`Remove ${attachment.name}`}
                  className={styles.attachmentRemove}
                  disabled={busy}
                  onClick={() => onRemove(index)}
                  type="button"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function SkillMarkdown({
  generating,
  item,
  locked,
  stale,
  value,
}: {
  generating: boolean;
  item: SkillAppLayoutItem;
  locked: boolean;
  stale: boolean;
  value: string;
}) {
  const [showSource, setShowSource] = useState(false);
  return (
    <section aria-busy={generating} className={styles.field} aria-label={item.label}>
      <span className={styles.fieldHeader}>
        <span className={item.showLabel === false ? styles.visuallyHidden : styles.label}>{item.label}</span>
        <span className={styles.fieldHeaderActions}>
          {stale ? (
            <span aria-label="Based on previous inputs" className={styles.staleHint} role="status">
              Based on previous inputs
            </span>
          ) : null}
          {item.sourceToggle ? (
            <button
              className={styles.copyButton}
              disabled={locked}
              onClick={() => setShowSource(current => !current)}
              type="button"
            >
              {showSource ? 'View preview' : 'View source'}
            </button>
          ) : null}
          {item.copyable ? (
            <CopyButton
              className={styles.copyButton}
              disabled={locked || !value}
              text={value}
              label="Copy"
              variant="text"
            />
          ) : null}
        </span>
      </span>
      <div className={styles.markdownPreview}>
        {value ? (
          showSource ? <pre>{value}</pre> : <MarkdownView source={value} />
        ) : (
          <span className={styles.previewEmpty}>
            {generating ? 'Generating…' : item.placeholder ?? 'Markdown output will appear here'}
          </span>
        )}
      </div>
    </section>
  );
}

export function SkillDownload({
  generating,
  item,
  locked,
  value,
}: {
  generating: boolean;
  item: SkillAppLayoutItem;
  locked: boolean;
  value: string;
}) {
  const filename = item.filename ?? 'download.txt';
  const mediaType = item.mediaType ?? 'text/plain;charset=utf-8';
  return (
    <section aria-busy={generating} className={styles.field} aria-label={item.label}>
      <span className={item.showLabel === false ? styles.visuallyHidden : styles.label}>{item.label}</span>
      <div className={styles.downloadZone} aria-live="polite">
        {value ? (
          <>
            <span aria-hidden className={styles.downloadFileIcon}>⇩</span>
            <span className={styles.downloadDetails}>
              <span className={styles.downloadName} title={filename}>{filename}</span>
              <span className={styles.downloadDescription}>
                {item.description ?? describeDownload(mediaType)} · {formatBytes(new Blob([value]).size)}
              </span>
            </span>
            <button
              className={styles.downloadButton}
              disabled={locked}
              onClick={() => downloadText(value, filename, mediaType)}
              type="button"
            >
              Download
            </button>
          </>
        ) : (
          <span className={styles.downloadEmpty}>
            {generating ? 'Generating…' : 'A downloadable file will appear when content is ready.'}
          </span>
        )}
      </div>
    </section>
  );
}

export function SkillTextarea({
  generating,
  item,
  locked,
  onChange,
  path,
  ready,
  stale,
  value,
}: {
  generating: boolean;
  item: SkillAppLayoutItem;
  locked: boolean;
  onChange: (name: string, value: string) => void;
  path: string;
  ready: boolean;
  stale: boolean;
  value: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputId = `skillapp-${item.bind}-${path}`;

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || !item.autoGrow) { return; }
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight + 2}px`;
  }, [item.autoGrow, value]);

  return (
    <div className={styles.field}>
      <span className={styles.fieldHeader}>
        <label className={item.showLabel === false ? styles.visuallyHidden : styles.label} htmlFor={inputId}>
          {item.label}
        </label>
        <span className={styles.fieldHeaderActions}>
          {stale ? (
            <span aria-label="Based on previous inputs" className={styles.staleHint} role="status">
              Based on previous inputs
            </span>
          ) : null}
          {item.copyable ? (
            <CopyButton
              className={styles.copyButton}
              text={value}
              label="Copy"
              variant="text"
            />
          ) : null}
        </span>
      </span>
      <textarea
        aria-busy={generating}
        className={`${item.rows ? styles.sizedTextarea : ''} ${item.autoGrow ? styles.autoGrowTextarea : ''}`}
        id={inputId}
        disabled={locked || !ready}
        onChange={event => item.bind && onChange(item.bind, event.target.value)}
        placeholder={generating ? 'Generating…' : item.placeholder}
        readOnly={item.editable === false}
        ref={textareaRef}
        rows={item.rows}
        value={value}
      />
    </div>
  );
}

export function downloadText(value: string, filename: string, mediaType: string): void {
  const url = URL.createObjectURL(new Blob([value], { type: mediaType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function describeDownload(mediaType: string): string {
  const normalized = mediaType.toLowerCase();
  if (normalized.startsWith('text/markdown')) { return 'Markdown document'; }
  if (normalized.startsWith('application/json')) { return 'JSON document'; }
  if (normalized.startsWith('text/csv')) { return 'CSV document'; }
  return 'Text document';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) { return `${bytes} B`; }
  if (bytes < 1024 * 1024) { return `${Math.round(bytes / 1024)} KiB`; }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
