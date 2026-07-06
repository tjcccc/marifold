/**
 * Minimal markdown → token tree for assistant output. Deliberately hand-
 * rolled and DOM-free: the Markdown component renders the tree with React
 * elements, so no HTML string ever reaches innerHTML. Coverage matches what
 * models actually emit in chat: headings, paragraphs, fenced code, lists,
 * blockquotes, horizontal rules, inline code/bold/italic, and http(s) links
 * (anything else stays text).
 */
export type InlineNode =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: InlineNode[] }
  | { type: 'em'; children: InlineNode[] }
  | { type: 'link'; href: string; children: InlineNode[] };

export type MarkdownBlock =
  | { type: 'heading'; level: number; inline: InlineNode[] }
  | { type: 'paragraph'; inline: InlineNode[] }
  | { type: 'code'; lang?: string; text: string }
  | { type: 'list'; ordered: boolean; items: InlineNode[][] }
  | { type: 'quote'; blocks: MarkdownBlock[] }
  | { type: 'rule' };

export function parseMarkdown(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    const fence = /^```(\S*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1; // closing fence (or end of input)
      blocks.push({ type: 'code', ...(fence[1] ? { lang: fence[1] } : {}), text: body.join('\n') });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, inline: parseInline(heading[2]) });
      index += 1;
      continue;
    }

    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      blocks.push({ type: 'rule' });
      index += 1;
      continue;
    }

    // Blockquote: strip one `>` marker per line and parse the inside as its
    // own document (nested quotes/lists/code work for free). Consecutive `>`
    // lines form one quote; a lazy continuation ends it (models rarely lazy-wrap).
    if (quoteLine(line) !== undefined) {
      const inner: string[] = [];
      while (index < lines.length) {
        const stripped = quoteLine(lines[index]);
        if (stripped === undefined) break;
        inner.push(stripped);
        index += 1;
      }
      blocks.push({ type: 'quote', blocks: parseMarkdown(inner.join('\n')) });
      continue;
    }

    const listMatch = listItem(line);
    if (listMatch) {
      const ordered = listMatch.ordered;
      const items: InlineNode[][] = [];
      while (index < lines.length) {
        const item = listItem(lines[index]);
        if (!item || item.ordered !== ordered) break;
        items.push(parseInline(item.text));
        index += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    // Paragraph: consume until a blank line or another block opener.
    const paragraph: string[] = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() !== '' &&
      !/^```/.test(lines[index]) &&
      !/^#{1,6}\s/.test(lines[index]) &&
      quoteLine(lines[index]) === undefined &&
      !/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(lines[index]) &&
      !listItem(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push({ type: 'paragraph', inline: parseInline(paragraph.join('\n')) });
  }

  return blocks;
}

/** The line's content with one leading `>` marker removed, or undefined when
 * the line is not part of a blockquote. A bare `>` is an empty quote line. */
function quoteLine(line: string): string | undefined {
  const match = /^\s*>\s?(.*)$/.exec(line);
  return match ? match[1] : undefined;
}

function listItem(line: string): { ordered: boolean; text: string } | undefined {
  const unordered = /^\s*[-*]\s+(.*)$/.exec(line);
  if (unordered) return { ordered: false, text: unordered[1] };
  const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
  if (ordered) return { ordered: true, text: ordered[1] };
  return undefined;
}

const INLINE_PATTERN =
  /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\((https?:\/\/[^\s)]+)\))/;

export function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let rest = text;
  while (rest.length > 0) {
    const match = INLINE_PATTERN.exec(rest);
    if (!match || match.index === undefined) {
      nodes.push({ type: 'text', text: rest });
      break;
    }
    if (match.index > 0) nodes.push({ type: 'text', text: rest.slice(0, match.index) });
    const token = match[0];
    if (token.startsWith('`')) {
      nodes.push({ type: 'code', text: token.slice(1, -1) });
    } else if (token.startsWith('**')) {
      nodes.push({ type: 'strong', children: parseInline(token.slice(2, -2)) });
    } else if (token.startsWith('*')) {
      nodes.push({ type: 'em', children: parseInline(token.slice(1, -1)) });
    } else {
      // [label](https://…) — only http(s) becomes a link; the pattern enforces it.
      const label = token.slice(1, token.indexOf(']'));
      const href = match[5];
      nodes.push({ type: 'link', href, children: parseInline(label) });
    }
    rest = rest.slice(match.index + token.length);
  }
  return nodes;
}
