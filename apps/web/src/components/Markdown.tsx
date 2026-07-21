import { useMemo } from 'react';
import type { InlineNode, MarkdownBlock } from '../lib/markdown';
import { parseMarkdown } from '../lib/markdown';
import styles from './Markdown.module.css';

/** Renders assistant markdown from the lib/markdown token tree — React
 * elements only, no innerHTML anywhere. */
export function Markdown({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <div className={styles.root}>
      {blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </div>
  );
}

function Block({ block }: { block: MarkdownBlock }) {
  switch (block.type) {
    case 'heading': {
      const Tag = `h${Math.min(block.level + 2, 6)}` as 'h3' | 'h4' | 'h5' | 'h6';
      return (
        <Tag className={styles.heading}>
          <Inline nodes={block.inline} />
        </Tag>
      );
    }
    case 'code':
      return (
        <pre className={styles.code}>
          <code>{block.text}</code>
        </pre>
      );
    case 'list': {
      const items = block.items.map((item, index) => (
        <li key={index}>
          <Inline nodes={item} />
        </li>
      ));
      return block.ordered ? <ol className={styles.list}>{items}</ol> : <ul className={styles.list}>{items}</ul>;
    }
    case 'quote':
      return (
        <blockquote className={styles.quote}>
          {block.blocks.map((inner, index) => (
            <Block key={index} block={inner} />
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
                    <Inline nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} style={{ textAlign: block.alignments[cellIndex] }}>
                      <Inline nodes={cell} />
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
          <Inline nodes={block.inline} />
        </p>
      );
  }
}

function Inline({ nodes }: { nodes: InlineNode[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        switch (node.type) {
          case 'text':
            return <span key={index}>{node.text}</span>;
          case 'code':
            return (
              <code key={index} className={styles.inlineCode}>
                {node.text}
              </code>
            );
          case 'strong':
            return (
              <strong key={index}>
                <Inline nodes={node.children} />
              </strong>
            );
          case 'em':
            return (
              <em key={index}>
                <Inline nodes={node.children} />
              </em>
            );
          case 'link':
            return (
              <a key={index} href={node.href} target="_blank" rel="noreferrer noopener" className={styles.link}>
                <Inline nodes={node.children} />
              </a>
            );
        }
      })}
    </>
  );
}
