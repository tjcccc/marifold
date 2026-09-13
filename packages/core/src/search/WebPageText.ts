import { parse, type DefaultTreeAdapterMap } from 'parse5';
type Node = DefaultTreeAdapterMap['node'];
const ignored = new Set(['script', 'style', 'noscript', 'nav', 'footer', 'form', 'svg', 'iframe', 'template']);
const blocks = new Set(['p', 'div', 'section', 'article', 'main', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'br', 'table']);

export function extractPageText(html: string): { title: string; lines: string[] } {
  const document = parse(html);
  const pending: Node[] = [document];
  const parts: string[] = [];
  let title = '';
  while (pending.length) {
    const node = pending.pop()!;
    if ('tagName' in node) {
      if (node.tagName === 'meta') {
        const key = node.attrs.find(a => a.name === 'property' || a.name === 'name')?.value ?? '';
        const value = node.attrs.find(a => a.name === 'content')?.value;
        if (value && /published|modified|date/i.test(key)) parts.push(`\nMetadata ${key}: ${value}\n`);
      }
      if (node.tagName === 'time') {
        const date = node.attrs.find(a => a.name === 'datetime')?.value;
        if (date) parts.push(` [${date}] `);
      }
      if (node.tagName === 'title') {
        title = node.childNodes.filter(child => 'value' in child).map(child => 'value' in child ? child.value : '').join('').trim().slice(0, 200);
        continue;
      }
      if (ignored.has(node.tagName) || node.attrs.some(a => a.name === 'hidden' || a.name === 'aria-hidden' && a.value === 'true')) continue;
      if (blocks.has(node.tagName)) parts.push('\n');
      if (node.tagName === 'td' || node.tagName === 'th') parts.push(' | ');
    }
    if ('value' in node && node.nodeName === '#text') parts.push(node.value);
    if ('childNodes' in node) {
      for (let i = node.childNodes.length - 1; i >= 0; i--) pending.push(node.childNodes[i]!);
    }
  }
  const lines = parts.join('').split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return { title, lines };
}
