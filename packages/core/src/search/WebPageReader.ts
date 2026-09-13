import { Agent, type Dispatcher } from 'undici';
import { proxyDispatcher } from '../util/proxy';
import { publicWebUrl, resolvePublicAddress } from './PublicWebUrl';
import { extractPageText } from './WebPageText';

const MAX_TEXT_CHARS = 12_000;

export interface WebPage { url: string; title: string; text: string; fetchedAt: string; truncated: boolean }

/** Reads public pages without scripts, cookies, authentication, or subresources. */
export class WebPageReader {
  constructor(private readonly options: { proxy?: string } = {}) {}

  async read(value: string, focus?: string, signal?: AbortSignal): Promise<WebPage> {
    let url = publicWebUrl(value);
    const timeout = AbortSignal.timeout(10_000);
    const boundedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    for (let redirects = 0; redirects <= 3; redirects++) {
      boundedSignal.throwIfAborted();
      // Check every hop. With a configured trusted proxy, final DNS/routing belongs
      // to that proxy. Direct connections pin the validated address against rebinding.
      const address = await abortable(resolvePublicAddress(url), boundedSignal);
      const dispatcher: Dispatcher = proxyDispatcher(this.options.proxy) ?? new Agent({
        connect: { lookup: (_host, options, callback) => {
          const family = address.includes(':') ? 6 : 4;
          if (options.all) callback(null, [{ address, family }]);
          else callback(null, address, family);
        } },
      });
      try {
        const init: RequestInit & { dispatcher: Dispatcher } = {
          signal: boundedSignal, dispatcher, redirect: 'manual',
          headers: { 'user-agent': 'Mozilla/5.0', accept: 'text/html, text/plain;q=0.9' },
        };
        const response = await fetch(url, init);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          const location = response.headers.get('location');
          if (!location || redirects === 3) throw new Error('Page redirect limit exceeded or missing location.');
          url = publicWebUrl(new URL(location, url).href);
          continue;
        }
        if (!response.ok) { await response.body?.cancel(); throw new Error(`Page request failed: HTTP ${response.status}.`); }
        const type = response.headers.get('content-type') ?? '';
        if (!/^(text\/html|text\/plain|application\/xhtml\+xml)\b/i.test(type)) {
          await response.body?.cancel(); throw new Error('Page reader supports HTML and plain text only.');
        }
        const bytes = await readBytes(response);
        const charset = type.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1]
          ?? bytes.toString('ascii', 0, 2048).match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] ?? 'utf-8';
        let source: string;
        try { source = new TextDecoder(charset).decode(bytes); } catch { source = bytes.toString('utf8'); }
        const page = /^text\/plain/i.test(type) ? { title: '', lines: source.split(/\n+/) } : extractPageText(source);
        if (!page.lines.length) throw new Error('Page has no readable text; it may require JavaScript. Try another source.');
        // Focus is a way to fit long pages, not a filter that discards useful
        // facts from short pages (numeric values may have no matching label).
        const selected = page.lines.join('\n').length <= MAX_TEXT_CHARS
          ? page.lines : focusLines(page.lines, focus);
        const content = selected.join('\n');
        return { url: url.href, title: page.title, text: content.slice(0, MAX_TEXT_CHARS),
          truncated: content.length > MAX_TEXT_CHARS || selected.length < page.lines.length, fetchedAt: new Date().toISOString() };
      } finally { await dispatcher.destroy(); }
    }
    throw new Error('Page redirect limit exceeded.');
  }
}

function focusLines(lines: string[], focus?: string): string[] {
  const terms = focus?.toLowerCase().split(/[\s,，]+/).filter(Boolean).slice(0, 8) ?? [];
  if (!terms.length) return lines;
  const indices = new Set<number>();
  for (let i = 0; i < Math.min(5, lines.length); i++) indices.add(i);
  for (let i = 0; i < lines.length; i++) {
    if (terms.some(term => lines[i]!.toLowerCase().includes(term))) {
      for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 3); j++) indices.add(j);
    }
  }
  return indices.size > 5 ? [...indices].sort((a, b) => a - b).map(i => lines[i]!) : lines;
}

async function readBytes(response: Response): Promise<Buffer> {
  if (!response.body) throw new Error('Page has no response body.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1_000_000) throw new Error('Page exceeds the 1 MB response limit.');
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', abort!); }
}
