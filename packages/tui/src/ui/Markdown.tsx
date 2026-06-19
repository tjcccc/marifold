import React from 'react';
import { Box, Text } from 'ink';
import { DIM } from './theme.js';

const CODE_COLOR = '#56B6C2';

/**
 * Pragmatic markdown renderer for assistant output — covers the constructs the
 * model actually emits: fenced code blocks, headings, bullet/numbered lists,
 * blockquotes, and inline `code` / **bold** / *italic*. Not a full parser; it
 * degrades to plain text on anything it doesn't recognize.
 */
export function Markdown({ text }: { text: string }): React.ReactElement {
  const lines = text.split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1; // consume the closing fence (if present)
      blocks.push(
        <Box key={key++} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
          {(code.length ? code : ['']).map((c, j) => (
            <Text key={j} color={CODE_COLOR}>{c.length ? c : ' '}</Text>
          ))}
        </Box>,
      );
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push(<Text key={key++} bold color="white">{heading[2]}</Text>);
      i += 1;
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      blocks.push(<Text key={key++} color={DIM}>│ {renderInline(quote[1])}</Text>);
      i += 1;
      continue;
    }

    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      blocks.push(<Text key={key++}>{bullet[1]}• {renderInline(bullet[2])}</Text>);
      i += 1;
      continue;
    }

    const numbered = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (numbered) {
      blocks.push(<Text key={key++}>{numbered[1]}{numbered[2]}. {renderInline(numbered[3])}</Text>);
      i += 1;
      continue;
    }

    blocks.push(<Text key={key++}>{line.length ? renderInline(line) : ' '}</Text>);
    i += 1;
  }

  return <Box flexDirection="column">{blocks}</Box>;
}

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_)/g;

/** Split a line into inline-styled segments (code / bold / italic). */
function renderInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  INLINE.lastIndex = 0;
  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('`')) {
      parts.push(<Text key={key++} color={CODE_COLOR}>{token.slice(1, -1)}</Text>);
    } else if (token.startsWith('**')) {
      parts.push(<Text key={key++} bold>{token.slice(2, -2)}</Text>);
    } else {
      parts.push(<Text key={key++} italic>{token.slice(1, -1)}</Text>);
    }
    last = match.index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length ? parts : text;
}
