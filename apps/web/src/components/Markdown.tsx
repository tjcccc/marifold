import { useMemo } from 'react';
import type { InlineNode, MarkdownBlock } from '../lib/markdown';
import { parseMarkdown } from '../lib/markdown';
import { CopyButton } from './CopyButton';
import styles from './Markdown.module.css';

export type SandboxLinkResolver = (href: string) => (() => void) | undefined;

/** Renders assistant markdown from the lib/markdown token tree — React
 * elements only, no innerHTML anywhere. */
export function Markdown({
  source,
  muted = false,
  resolveSandboxLink,
}: {
  source: string;
  muted?: boolean;
  resolveSandboxLink?: SandboxLinkResolver;
}) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <div className={`${styles.root}${muted ? ` ${styles.muted}` : ''}`}>
      {blocks.map((block, index) => (
        <Block key={index} block={block} resolveSandboxLink={resolveSandboxLink} />
      ))}
    </div>
  );
}

function Block({ block, resolveSandboxLink }: { block: MarkdownBlock; resolveSandboxLink?: SandboxLinkResolver }) {
  switch (block.type) {
    case 'heading': {
      const Tag = `h${Math.min(block.level + 2, 6)}` as 'h3' | 'h4' | 'h5' | 'h6';
      return (
        <Tag className={styles.heading}>
          <Inline nodes={block.inline} resolveSandboxLink={resolveSandboxLink} />
        </Tag>
      );
    }
    case 'code':
      return (
        <div className={styles.codeBlock}>
          <div className={styles.codeHeader}>
            <span>{codeLanguageLabel(block.lang)}</span>
            <CopyButton text={block.text} label="Copy code" className={styles.copyButton} />
          </div>
          <pre className={styles.code}>
            <code>{block.text}</code>
          </pre>
        </div>
      );
    case 'list': {
      const items = block.items.map((item, index) => (
        <li key={index}>
          <Inline nodes={item} resolveSandboxLink={resolveSandboxLink} />
        </li>
      ));
      return block.ordered ? <ol className={styles.list}>{items}</ol> : <ul className={styles.list}>{items}</ul>;
    }
    case 'quote':
      return (
        <blockquote className={styles.quote}>
          {block.blocks.map((inner, index) => (
            <Block key={index} block={inner} resolveSandboxLink={resolveSandboxLink} />
          ))}
        </blockquote>
      );
    case 'table':
      return (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                {block.header.map((cell, index) => (
                  <th key={index} scope="col" style={{ textAlign: block.alignments[index] }}>
                    <Inline nodes={cell} resolveSandboxLink={resolveSandboxLink} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} style={{ textAlign: block.alignments[cellIndex] }}>
                      <Inline nodes={cell} resolveSandboxLink={resolveSandboxLink} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'rule':
      return <hr className={styles.rule} />;
    case 'paragraph':
      return (
        <p className={styles.paragraph}>
          <Inline nodes={block.inline} resolveSandboxLink={resolveSandboxLink} />
        </p>
      );
  }
}

const CODE_LANGUAGE_LABELS: Record<string, string> = {
  bash: 'Bash',
  css: 'CSS',
  html: 'HTML',
  javascript: 'JavaScript',
  js: 'JavaScript',
  json: 'JSON',
  jsx: 'JSX',
  markdown: 'Markdown',
  md: 'Markdown',
  python: 'Python',
  py: 'Python',
  shell: 'Shell',
  sh: 'Shell',
  sql: 'SQL',
  ts: 'TypeScript',
  tsx: 'TSX',
  typescript: 'TypeScript',
  xml: 'XML',
  yaml: 'YAML',
  yml: 'YAML',
};

function codeLanguageLabel(language?: string): string {
  if (!language) return 'Code';
  return CODE_LANGUAGE_LABELS[language.toLowerCase()] ?? language;
}

function Inline({ nodes, resolveSandboxLink }: { nodes: InlineNode[]; resolveSandboxLink?: SandboxLinkResolver }) {
  return (
    <>
      {nodes.map((node, index) => {
        switch (node.type) {
          case 'text':
            return <span key={index}>{node.text}</span>;
          case 'break':
            return <br key={index} />;
          case 'code':
            return (
              <code key={index} className={styles.inlineCode}>
                {node.text}
              </code>
            );
          case 'strong':
            return (
              <strong key={index}>
                <Inline nodes={node.children} resolveSandboxLink={resolveSandboxLink} />
              </strong>
            );
          case 'em':
            return (
              <em key={index}>
                <Inline nodes={node.children} resolveSandboxLink={resolveSandboxLink} />
              </em>
            );
          case 'link':
            if (node.href.startsWith('sandbox:')) {
              const onClick = resolveSandboxLink?.(node.href);
              return onClick ? (
                <button key={index} type="button" onClick={onClick} className={`${styles.link} ${styles.downloadLink}`}>
                  <Inline nodes={node.children} resolveSandboxLink={resolveSandboxLink} />
                </button>
              ) : (
                <span key={index}>
                  <Inline nodes={node.children} resolveSandboxLink={resolveSandboxLink} />
                </span>
              );
            }
            return (
              <a key={index} href={node.href} target="_blank" rel="noreferrer noopener" className={styles.link}>
                <Inline nodes={node.children} resolveSandboxLink={resolveSandboxLink} />
              </a>
            );
        }
      })}
    </>
  );
}
