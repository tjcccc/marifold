import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ApiClient } from '../../api/client';
import { Markdown } from '../../components/Markdown';
import { CopyButton } from '../../components/CopyButton';
import { ImagePreviewDialog } from '../../components/ImagePreviewDialog';
import type { PreviewImage } from '../../components/ImagePreviewDialog';
import type { RunApprovalAction } from '../../api/types';
import { splitLeading } from '../../lib/commandSyntax';
import { formatCostUSD, formatDuration, formatRunDuration, formatTokens } from '../../lib/format';
import type { ResponseMetaState, RunCardState, ThreadItem, UserAttachment } from '../../state/thread';
import { hasRunActivity, isTrivialRun } from '../../state/thread';
import { RunCard } from './RunCard';
import styles from './ThreadView.module.css';

export interface ThreadViewProps {
  client?: ApiClient;
  items: ThreadItem[];
  onCancelRun: (runId: string) => void;
  onAnswerApproval: (runId: string, requestId: string, action: RunApprovalAction) => void;
  onToggleRun: (runId: string) => void;
  /** Regenerate one user→assistant exchange in place from an inline editor. */
  onEditUserMessage?: (itemId: string, text: string) => Promise<boolean>;
  /** Hide new edit affordances while another request is active. */
  editingDisabled?: boolean;
  /** Increment for an explicit user submission, which always repins the tail. */
  scrollToBottomRequest?: number;
}

/** The conversation: user bubbles right, assistant markdown blocks, notices,
 * and run cards. Auto-follows the tail unless the user scrolled up. */
export function ThreadView({
  client,
  items,
  onCancelRun,
  onAnswerApproval,
  onToggleRun,
  onEditUserMessage,
  editingDisabled = false,
  scrollToBottomRequest = 0,
}: ThreadViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const scrollRequestRef = useRef(scrollToBottomRequest);
  const [preview, setPreview] = useState<{ images: PreviewImage[]; index: number }>();
  const [editingItemId, setEditingItemId] = useState<string>();

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (scrollRequestRef.current !== scrollToBottomRequest) pinnedRef.current = true;
    if (node && pinnedRef.current) node.scrollTop = node.scrollHeight;
    scrollRequestRef.current = scrollToBottomRequest;
  }, [items, scrollToBottomRequest]);

  function onScroll(): void {
    const node = scrollRef.current;
    if (!node) return;
    pinnedRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 60;
  }

  // One pass: run lookup for the assistant meta suffix, plus which runs
  // already stream prose (their thinking line comes down at that point).
  const runs = new Map<string, RunCardState>();
  const proseRuns = new Set<string>();
  for (const item of items) {
    if (item.kind === 'run') runs.set(item.run.runId, item.run);
    else if (item.kind === 'assistant' && item.runId) proseRuns.add(item.runId);
  }

  return (
    <div ref={scrollRef} className={styles.scroll} onScroll={onScroll} role="log" aria-label="Conversation">
      <div className={styles.thread}>
        {items.length === 0 ? (
          <div className={styles.empty}>
            <div className={styles.emptyTitle}>What should we work on?</div>
            <div className={styles.emptyHint}>Plain questions get answers; tasks run with tools.</div>
          </div>
        ) : null}
        {items.map(item => (
          <ThreadItemView
            key={item.id}
            item={item}
            runs={runs}
            proseRuns={proseRuns}
            onCancelRun={onCancelRun}
            onAnswerApproval={onAnswerApproval}
            onToggleRun={onToggleRun}
            onEditUserMessage={onEditUserMessage}
            editingDisabled={editingDisabled}
            editing={editingItemId === item.id}
            onStartEditing={() => setEditingItemId(item.id)}
            onCancelEditing={() => setEditingItemId(undefined)}
            onPreviewImages={(images, index) => setPreview({ images, index })}
            client={client}
          />
        ))}
      </div>
      {preview ? (
        <ImagePreviewDialog
          images={preview.images}
          initialIndex={preview.index}
          loadImage={client ? path => client.blob(path) : undefined}
          onClose={() => setPreview(undefined)}
        />
      ) : null}
    </div>
  );
}

function ThreadItemView({
  item,
  runs,
  proseRuns,
  onCancelRun,
  onAnswerApproval,
  onToggleRun,
  onEditUserMessage,
  editingDisabled,
  editing,
  onStartEditing,
  onCancelEditing,
  onPreviewImages,
  client,
}: {
  item: ThreadItem;
  runs: Map<string, RunCardState>;
  proseRuns: Set<string>;
  editing: boolean;
  onStartEditing: () => void;
  onCancelEditing: () => void;
  onPreviewImages: (images: PreviewImage[], index: number) => void;
  client?: ApiClient;
} & Pick<ThreadViewProps, 'onCancelRun' | 'onAnswerApproval' | 'onToggleRun' | 'onEditUserMessage' | 'editingDisabled'>) {
  switch (item.kind) {
    case 'user': {
      const previewImages = (item.attachments ?? []).flatMap(attachment =>
        attachment.kind === 'image' && (attachment.previewUrl || attachment.sourcePath)
          ? [{
              ...(attachment.previewUrl ? { src: attachment.previewUrl } : {}),
              ...(attachment.sourcePath ? { sourcePath: attachment.sourcePath } : {}),
              alt: attachment.name,
            }]
          : [],
      );
      return (
        <div className={`${styles.userTurn} ${editing ? styles.userTurnEditing : ''}`}>
          {item.attachments && item.attachments.length > 0 ? (
            <div className={styles.userAttachments}>
              {item.attachments.map((attachment, index) =>
                attachment.kind === 'image' && (attachment.previewUrl || attachment.sourcePath) ? (
                  <button
                    key={index}
                    className={styles.userImageButton}
                    type="button"
                    aria-label={`Preview ${attachment.name}`}
                    onClick={() => onPreviewImages(
                      previewImages,
                      item.attachments!
                        .slice(0, index + 1)
                        .filter(candidate => candidate.kind === 'image' && (candidate.previewUrl || candidate.sourcePath))
                        .length - 1,
                    )}
                  >
                    <LazyTranscriptImage
                      client={client}
                      previewUrl={attachment.previewUrl}
                      sourcePath={attachment.sourcePath}
                      alt={attachment.name}
                    />
                  </button>
                ) : (
                  <span key={index} className={styles.userFile}>
                    <span aria-hidden>{officeAttachmentGlyph(attachment.officeKind)}</span> {attachment.name}
                  </span>
                ),
              )}
            </div>
          ) : null}
          {editing && onEditUserMessage ? (
            <UserMessageEditor
              initialText={item.text}
              onCancel={onCancelEditing}
              onSubmit={async text => {
                const replaced = await onEditUserMessage(item.id, text);
                if (replaced) onCancelEditing();
                return replaced;
              }}
            />
          ) : (
            <>
              <div className={styles.userBubble}>{renderUserText(item.text)}</div>
              <div className={styles.userActions} role="group" aria-label="Message actions">
                <CopyButton
                  text={item.text}
                  label="Copy prompt"
                  className={styles.userActionButton}
                />
                {onEditUserMessage && !editingDisabled ? (
                  <button
                    type="button"
                    className={styles.userActionButton}
                    aria-label="Edit and resend message"
                    title="Edit and resend"
                    onClick={onStartEditing}
                  >
                    <EditGlyph />
                  </button>
                ) : null}
              </div>
            </>
          )}
        </div>
      );
    }
    case 'assistant': {
      const run = item.runId ? runs.get(item.runId) : undefined;
      const secondary = item.runPhase === 'progress' || item.runPhase === 'reasoning';
      const meta = !secondary && !item.streaming
        ? run && run.status !== 'running'
          ? runMetaText(run)
          : item.responseMeta?.finishedAt
            ? responseMetaText(item.responseMeta)
            : undefined
        : undefined;
      const copyable = !secondary && !item.streaming && item.markdown.trim().length > 0;
      return (
        <div className={styles.assistant} data-run-phase={item.runPhase}>
          <Markdown source={item.markdown} muted={secondary} />
          {item.streaming ? <span className={styles.cursor} aria-hidden /> : null}
          {meta || copyable ? (
            <div className={styles.responseFooter}>
              {copyable ? (
                <CopyButton
                  text={item.markdown}
                  label="Copy response"
                  className={styles.responseCopyButton}
                />
              ) : null}
              {meta ? <div className={styles.meta}>{meta}</div> : null}
            </div>
          ) : null}
        </div>
      );
    }
    case 'notice': {
      // Multi-line notices (e.g. /help) render as a left-aligned block instead
      // of the centered pill so the lines don't collapse into a run-on.
      const block = item.text.includes('\n');
      return (
        <div className={`${styles.notice} ${block ? styles.noticeBlock : ''} ${styles[`notice_${item.tone}`]}`}>
          {item.text}
        </div>
      );
    }
    case 'run': {
      const run = item.run;
      if (!hasRunActivity(run)) {
        // No tools/plan/approval: nothing card-worthy. While the model is
        // still silent, show an inline thinking line; once prose streams (or
        // the run completes) the response itself carries the state.
        if (isTrivialRun(run)) return null;
        if (run.status === 'running') {
          if (proseRuns.has(run.runId)) return null;
          return (
            <div className={styles.thinking}>
              <span className={styles.thinkingLabel}>Thinking…</span>
              <button className={styles.cancelLink} onClick={() => onCancelRun(run.runId)}>
                Cancel
              </button>
            </div>
          );
        }
        // failed / cancelled / blocked without activity → the card's status
        // footer is still the only place that tells the user what happened.
      }
      return (
        <RunCard
          run={run}
          onCancel={() => onCancelRun(run.runId)}
          onAnswer={(requestId, action) => onAnswerApproval(run.runId, requestId, action)}
          onToggle={() => onToggleRun(run.runId)}
        />
      );
    }
  }
}

function officeAttachmentGlyph(kind: UserAttachment['officeKind']): string {
  if (kind === 'word') return 'W';
  if (kind === 'spreadsheet') return 'X';
  if (kind === 'presentation') return 'P';
  return '📄';
}

function LazyTranscriptImage({
  client,
  previewUrl,
  sourcePath,
  alt,
}: {
  client?: ApiClient;
  previewUrl?: string;
  sourcePath?: string;
  alt: string;
}) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const [src, setSrc] = useState(previewUrl);

  useEffect(() => {
    setSrc(previewUrl);
    if (previewUrl || !sourcePath || !client) return;
    const host = hostRef.current;
    let cancelled = false;
    let objectUrl: string | undefined;
    const load = () => {
      client.blob(sourcePath).then(blob => {
        if (cancelled || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      }).catch(() => undefined);
    };
    if (!host || typeof IntersectionObserver === 'undefined') {
      load();
    } else {
      const observer = new IntersectionObserver(entries => {
        if (!entries.some(entry => entry.isIntersecting)) return;
        observer.disconnect();
        load();
      }, { rootMargin: '240px' });
      observer.observe(host);
      return () => {
        cancelled = true;
        observer.disconnect();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      };
    }
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [client, previewUrl, sourcePath]);

  return (
    <span ref={hostRef}>
      {src ? <img className={styles.userImage} src={src} alt={alt} loading="lazy" /> : (
        <span className={styles.userImagePlaceholder} aria-label={`${alt} loading`} />
      )}
    </span>
  );
}

function UserMessageEditor({
  initialText,
  onCancel,
  onSubmit,
}: {
  initialText: string;
  onCancel: () => void;
  onSubmit: (text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);

  useLayoutEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
    autosizeEditor(node);
  }, []);

  async function submit(): Promise<void> {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    const replaced = await onSubmit(value);
    if (!replaced) setBusy(false);
  }

  return (
    <div className={styles.userEditor}>
      <textarea
        ref={textareaRef}
        className={styles.userEditorInput}
        aria-label="Edit message"
        value={text}
        rows={1}
        disabled={busy}
        onChange={event => {
          setText(event.target.value);
          autosizeEditor(event.currentTarget);
        }}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
        onKeyDown={event => {
          if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div className={styles.userEditorActions}>
        <button type="button" className={styles.editorCancel} disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className={styles.editorSend}
          disabled={busy || text.trim().length === 0}
          onClick={() => void submit()}
        >
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}

function autosizeEditor(node: HTMLTextAreaElement): void {
  node.style.height = 'auto';
  node.style.height = `${Math.min(node.scrollHeight, 320)}px`;
}

function EditGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden focusable="false">
      <path d="m3 11.8.45-2.25 6.8-6.8a1.35 1.35 0 0 1 1.9 0l1.1 1.1a1.35 1.35 0 0 1 0 1.9l-6.8 6.8L4.2 13 3 11.8Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
      <path d="m9.5 3.5 3 3M3.5 12.5h9" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

/** ChatGPT-style suffix under the run's response: `2s · 512 tokens · $0.01`. */
function runMetaText(run: RunCardState): string {
  return formatResponseMeta(
    formatRunDuration(run.startedAt, run.finishedAt),
    run.usage,
  );
}

function responseMetaText(meta: ResponseMetaState): string {
  const duration = meta.latencyMs !== undefined
    ? formatDuration(meta.latencyMs)
    : formatRunDuration(meta.startedAt, meta.finishedAt);
  return formatResponseMeta(duration, meta.usage);
}

function formatResponseMeta(duration: string, usage?: ResponseMetaState['usage']): string {
  const parts = [duration];
  if (usage?.totalTokens !== undefined) parts.push(`${formatTokens(usage.totalTokens)} tokens`);
  if (usage?.reasoningTokens !== undefined) parts.push(`${formatTokens(usage.reasoningTokens)} reasoning`);
  if (usage?.estimatedCostUSD !== undefined) parts.push(formatCostUSD(usage.estimatedCostUSD));
  return parts.join(' · ');
}

/** A user bubble with the leading `$skill` token highlighted (mirrors the
 * composer). Non-skill messages render as plain text. */
function renderUserText(text: string): ReactNode {
  const { token, rest } = splitLeading(text);
  if (!token) return text;
  return (
    <>
      <span className={styles.skillToken}>{token}</span>
      {rest}
    </>
  );
}
