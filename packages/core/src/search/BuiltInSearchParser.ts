import { parse, type DefaultTreeAdapterMap } from 'parse5';
import type { SearchResultItem } from './SearchBackend';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

function elements(root: Node): Element[] {
  const result: Element[] = [];
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if ('tagName' in node) result.push(node);
    if ('childNodes' in node) pending.push(...[...node.childNodes].reverse());
  }
  return result;
}
function attr(node: Element, name: string): string {
  return node.attrs.find(attribute => attribute.name === name)?.value ?? '';
}
function hasClass(node: Element, name: string): boolean {
  return attr(node, 'class').split(/\s+/).includes(name);
}
function text(root: Node): string {
  const parts: string[] = [];
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if ('tagName' in node && ['script', 'style'].includes(node.tagName)) continue;
    if ('value' in node && node.nodeName === '#text') parts.push(node.value);
    if ('childNodes' in node) pending.push(...[...node.childNodes].reverse());
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
export function normalizeSearchResults(results: SearchResultItem[], limit: number): SearchResultItem[] {
  const seen = new Set<string>();
  const normalized: SearchResultItem[] = [];
  for (const result of results) {
    try {
      let url = new URL(result.url, 'https://duckduckgo.com');
      if (url.hostname === 'duckduckgo.com' && url.pathname === '/l/') {
        url = new URL(url.searchParams.get('uddg') ?? '');
      }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
      if (['duckduckgo.com', 'html.duckduckgo.com', 'search.brave.com'].includes(url.hostname)) continue;
      url.hash = '';
      for (const key of [...url.searchParams.keys()]) {
        if (/^utm_/i.test(key) || ['gclid', 'fbclid'].includes(key)) url.searchParams.delete(key);
      }
      const canonical = url.href;
      if (canonical.length > 4096) continue;
      const title = result.title.trim().slice(0, 200);
      if (!title || seen.has(canonical)) continue;
      seen.add(canonical);
      normalized.push({ title, url: canonical, snippet: result.snippet.trim().slice(0, 600) });
      if (normalized.length >= limit) break;
    } catch { /* Ignore malformed result links; they are untrusted external data. */ }
  }
  return normalized;
}

export function parseDuckDuckGoHtml(html: string): SearchResultItem[] {
  const nodes = elements(parse(html));
  if (nodes.some(node => attr(node, 'id') === 'challenge-form' || hasClass(node, 'anomaly-modal'))) {
    throw new Error('DuckDuckGo blocked automated search.');
  }
  const results = nodes.filter(node => hasClass(node, 'result')).flatMap(node => {
    if (hasClass(node, 'result--ad')) return [];
    const children = elements(node);
    const anchor = children.find(child => child.tagName === 'a' && hasClass(child, 'result__a'));
    const snippet = children.find(child => hasClass(child, 'result__snippet'));
    return anchor ? [{ title: text(anchor), url: attr(anchor, 'href'), snippet: snippet ? text(snippet) : '' }] : [];
  });
  if (!results.length && !nodes.some(node => hasClass(node, 'no-results'))) {
    throw new Error('DuckDuckGo returned an unrecognized search page.');
  }
  return results;
}

export function parseBraveHtml(html: string): SearchResultItem[] {
  const nodes = elements(parse(html));
  const operators = nodes.find(node => attr(node, 'id') === 'advanced-keywords');
  if (operators && /were not applied/i.test(text(operators))) {
    throw new Error('Brave could not honor the query operators.');
  }
  const results = nodes.filter(node => hasClass(node, 'snippet') && attr(node, 'data-type') === 'web').flatMap(node => {
    const children = elements(node);
    const anchor = children.find(child => child.tagName === 'a' && elements(child).some(descendant => hasClass(descendant, 'search-snippet-title')));
    const title = anchor && elements(anchor).find(child => hasClass(child, 'search-snippet-title'));
    const snippet = children.find(child => hasClass(child, 'generic-snippet'));
    return anchor && title ? [{ title: text(title), url: attr(anchor, 'href'), snippet: snippet ? text(snippet) : '' }] : [];
  });
  if (!results.length) throw new Error('Brave returned a blocked or unrecognized search page.');
  return results;
}
