import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Box, Text, renderToString, measureElement, useBoxMetrics, useInput, type DOMElement } from 'ink';
import sliceAnsi from 'slice-ansi';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import type { TranscriptItem } from '../core/appState.js';
import { TranscriptRow, topGap } from './Transcript.js';
import { useTerminalSize } from './useTerminalSize.js';
import { SelectionCopyContext, useMouse } from './Mouse.js';
import { mapSelectionLines, orderedSelection, selectedText, type SelectionLine, type Selection, type Position } from './selection.js';
import { copyTerminalSelection } from './appHelpers.js';

interface Props {
  items: TranscriptItem[];
  header: ReactNode;
  footer: ReactNode;
  keyboardActive: boolean;
  workspaceNotice?: string;
  onCopy?: (text: string) => Promise<void>;
}

/** Render existing transcript components into cached, styled rows so history
 * scrolling and selection only render the visible terminal viewport. */
export function FullScreen({ items, header, footer, keyboardActive, workspaceNotice, onCopy = copyTerminalSelection }: Props) {
  const { columns, rows } = useTerminalSize();
  const width = Math.max(1, columns - 1);
  const viewport = useRef<DOMElement>(null);
  const metrics = useBoxMetrics(viewport);
  const [lines, setLines] = useState<SelectionLine[]>([]);
  const [offset, setOffset] = useState<number | null>(null);
  const [selection, setSelection] = useState<Selection>();
  const [frozen, setFrozen] = useState<SelectionLine[]>();
  const [copyStatus, setCopyStatus] = useState('');
  const drag = useRef<{ selection: Selection; lines: SelectionLine[]; top: number; offset: number | null } | undefined>(undefined);
  const cache = useRef(new WeakMap<TranscriptItem, { width: number; lines: SelectionLine[] }>());
  const height = Math.max(1, metrics.height);
  const displayed = frozen ?? lines;
  const maxOffset = Math.max(0, displayed.length - height);
  const top = Math.min(offset ?? maxOffset, maxOffset);

  useEffect(() => {
    // A separate task avoids nesting Ink's synchronous off-screen reconciler
    // inside the live tree's commit/effect pass.
    const task = setImmediate(() => {
      const headerLines = renderToString(<Box width={width}>{header}</Box>, { columns: width }).split('\n');
      const result = mapSelectionLines(headerLines, headerLines, 0);
      items.forEach((item, index) => {
        const previous = items[index - 1]?.kind ?? 'banner';
        if (topGap(item.kind, previous)) { result.push(...mapSelectionLines([''], [''], 0)); }
        let entry = cache.current.get(item);
        if (!entry || entry.width !== width) {
          const styled = renderToString(<Box width={width} paddingX={1}><TranscriptRow item={item} /></Box>, { columns: width }).split('\n');
          const logicalWidth = Math.max(width, ...JSON.stringify(item).split('\\n').map(line => stringWidth(line) + 8));
          const logical = logicalWidth === width ? styled : renderToString(<Box width={logicalWidth} paddingX={1}><TranscriptRow item={item} /></Box>, { columns: logicalWidth }).split('\n');
          entry = { width, lines: mapSelectionLines(styled, logical) };
          cache.current.set(item, entry);
        }
        result.push(...entry.lines);
      });
      setLines(result);
    });
    return () => { clearImmediate(task); };
  }, [items, header, width]);

  const firstId = items[0]?.id;
  const lastUserId = [...items].reverse().find(item => item.kind === 'user')?.id;
  useEffect(() => {
    setOffset(null); setSelection(undefined); setFrozen(undefined); setCopyStatus(''); drag.current = undefined;
  }, [width, rows, firstId, lastUserId]);

  const copySelection = (text: string) => {
    void onCopy(text).then(() => setCopyStatus('Copied'), () => setCopyStatus('Clipboard unavailable · use /copy or inline mode'));
  };

  const scroll = (delta: number) => {
    if (drag.current) { return; }
    const next = Math.max(0, Math.min(maxOffset, top + delta));
    setOffset(next === maxOffset ? null : next);
    setSelection(undefined); setFrozen(undefined); setCopyStatus('');
  };
  useInput((_input, key) => {
    if (key.eventType === 'release') { return; }
    if (key.pageUp) { scroll(-Math.max(1, height - 1)); }
    if (key.pageDown) { scroll(Math.max(1, height - 1)); }
    if (key.ctrl && key.end) {
      setOffset(null); setSelection(undefined); setFrozen(undefined); setCopyStatus('');
    }
  }, { isActive: keyboardActive });

  useMouse(event => {
    if (!viewport.current) { return; }
    const bounds = measureElement(viewport.current);
    const inside = event.y >= bounds.y && event.y < bounds.y + bounds.height && event.x >= bounds.x && event.x < bounds.x + bounds.width;
    if (event.action === 'wheel') {
      if (inside) { scroll(event.button === 0 ? -3 : 3); }
      return;
    }
    if (event.button !== 0) { return; }
    const snapshot = drag.current;
    const source = snapshot?.lines ?? displayed;
    const viewportRow = Math.max(0, Math.min(bounds.height - 1, event.y - bounds.y));
    const row = Math.max(0, Math.min(source.length - 1, (snapshot?.top ?? top) + viewportRow));
    const position: Position = { row, column: Math.max(0, Math.min(width, event.x - bounds.x)) };
    if (event.action === 'press') {
      if (!inside || !displayed.length) { return; }
      drag.current = { selection: { anchor: position, focus: position }, lines: displayed, top, offset };
      setFrozen(displayed); setOffset(top); setCopyStatus('');
      setSelection({ anchor: position, focus: position });
    } else if (snapshot) {
      const next = { anchor: snapshot.selection.anchor, focus: position };
      snapshot.selection = next;
      setSelection(next);
      if (event.action === 'release') {
        drag.current = undefined;
        const text = selectedText(source, next);
        if (text) {
          copySelection(text);
        } else {
          setSelection(undefined); setFrozen(undefined); setOffset(snapshot.offset);
        }
      }
    }
  });

  const visible = useMemo(() => displayed.slice(top, top + height), [displayed, top, height]);
  const range = selection ? orderedSelection(selection) : undefined;
  return (
    <Box width={width} height={Math.max(1, rows - 1)} flexDirection="column" overflow="hidden">
      <Box ref={viewport} flexDirection="column" flexGrow={1} flexShrink={1} minHeight={1} overflow="hidden">
        {visible.map((entry, index) => {
          const line = entry.styled;
          const row = top + index;
          if (!line || !range || row < range[0].row || row > range[1].row) { return <Text key={index} wrap="truncate-end">{line || ' '}</Text>; }
          // Off-screen rendering turns the transcript's one-cell padding into text.
          const padding = stripAnsi(line).startsWith(' ') ? 1 : 0;
          const start = Math.max(padding, row === range[0].row ? range[0].column : 0);
          const end = Math.max(start, row === range[1].row ? range[1].column : width);
          return <Text key={index} wrap="truncate-end">{sliceAnsi(line, 0, start)}<Text inverse>{sliceAnsi(line, start, end)}</Text>{sliceAnsi(line, end)}</Text>;
        })}
      </Box>
      <Box flexDirection="column" paddingTop={1} flexShrink={0} maxHeight={Math.max(1, rows - 2)} overflow="hidden">
        <Box paddingX={1} justifyContent="space-between">
          <Box flexGrow={1} flexShrink={1}>
            <Text dimColor wrap="truncate-end">{offset === null ? 'Wheel / PgUp: history · drag to copy' : 'History paused · PgDn / Ctrl+End: follow latest'}</Text>
          </Box>
          {!workspaceNotice && copyStatus ? <Text dimColor wrap="truncate-end">{copyStatus}</Text> : null}
        </Box>
        {workspaceNotice ? (
          <Box paddingX={1} justifyContent="space-between">
            <Box flexGrow={1} flexShrink={1}><Text dimColor wrap="truncate-end">{workspaceNotice}</Text></Box>
            {copyStatus ? <Text dimColor wrap="truncate-end">{copyStatus}</Text> : null}
          </Box>
        ) : null}
        <SelectionCopyContext.Provider value={copySelection}>{footer}</SelectionCopyContext.Provider>
      </Box>
    </Box>
  );
}
