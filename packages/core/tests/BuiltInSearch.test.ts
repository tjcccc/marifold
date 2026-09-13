import { afterEach, describe, expect, it, vi } from 'vitest';
import { BuiltInSearchBackend } from '../src/search/BuiltInSearchBackend';
import { normalizeSearchResults, parseBraveHtml, parseDuckDuckGoHtml } from '../src/search/BuiltInSearchParser';

const html = `<div class="result result--web"><h2><a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fdoc%3Futm_source%3Dsearch" class="result__a">Node &amp; <b>中文</b></a></h2><a class="result__snippet">Useful &quot;result&quot;</a></div>`;
const brave = '<div class="snippet" data-type="web"><a href="https://example.com/"><span>Site name</span><div class="search-snippet-title">Fallback</div></a><div class="generic-snippet">Second engine</div></div>';
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('built-in search', () => {
  it('parses HTML entities and redirect links, ignores ads, deduplicates and bounds results', () => {
    const raw = parseDuckDuckGoHtml(html + html + html.replace('result--web', 'result--ad'));
    expect(normalizeSearchResults(raw, 5)).toEqual([{ title: 'Node & 中文', url: 'https://example.org/doc', snippet: 'Useful "result"' }]);
    expect(normalizeSearchResults([{ title: 'x', url: 'javascript:alert(1)', snippet: '' }, { title: 'y', url: 'https://u:p@example.org', snippet: '' }], 5)).toEqual([]);
    expect(parseBraveHtml(brave)[0]).toMatchObject({ title: 'Fallback', url: 'https://example.com/' });
  });
  it('distinguishes empty search results from blocked or changed pages', () => {
    expect(parseDuckDuckGoHtml('<div class="no-results">No results</div>')).toEqual([]);
    expect(() => parseDuckDuckGoHtml('<form id="challenge-form">Confirm human</form>')).toThrow(/blocked/);
    expect(() => parseDuckDuckGoHtml('<html>Enable JavaScript</html>')).toThrow(/unrecognized/);
    expect(() => parseBraveHtml('<html>captcha</html>')).toThrow(/unrecognized/);
  });
  it('excludes Brave ads and refuses relaxed query operators without reading script dictionaries', () => {
    expect(parseBraveHtml(brave + brave.replace('data-type="web"', 'data-type="ad"'))).toHaveLength(1);
    expect(parseBraveHtml(brave + '<script>"search operators were not applied"</script>')).toHaveLength(1);
    expect(() => parseBraveHtml('<div id="advanced-keywords">search operators were not applied</div>' + brave)).toThrow(/query operators/);
  });
  it('uses direct search, caches bounded results, and expires its cache', async () => {
    const fetcher = vi.fn(async () => new Response(html));
    vi.stubGlobal('fetch', fetcher);
    const backend = new BuiltInSearchBackend();
    const first = await backend.search('中文 & test');
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('q')).toBe('中文 & test');
    first[0]!.title = 'Mutated';
    expect((await backend.search('中文 & test'))[0]!.title).toBe('Node & 中文');
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 300_001);
    await backend.search('中文 & test');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('keeps a genuine empty result empty without broadening to another engine', async () => {
    const fetcher = vi.fn(async () => new Response('<div class="no-results">No results</div>'));
    vi.stubGlobal('fetch', fetcher);
    expect(await new BuiltInSearchBackend().search('"no-such-phrase"')).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('bounds per-engine waiting time and recovers from a timeout', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementationOnce(async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    })).mockResolvedValueOnce(new Response(brave));
    vi.stubGlobal('fetch', fetcher);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
      return controller.signal;
    });
    const result = new BuiltInSearchBackend().search('query');
    await vi.advanceTimersByTimeAsync(5000);
    expect((await result)[0]!.title).toBe('Fallback');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('falls back to Brave on a block and never calls a paid backend', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('Blocked', { status: 403 })).mockResolvedValueOnce(new Response(brave));
    vi.stubGlobal('fetch', fetcher);
    expect(await new BuiltInSearchBackend().search('query')).toEqual([{ title: 'Fallback', url: 'https://example.com/', snippet: 'Second engine' }]);
    expect(fetcher.mock.calls.map(([url]) => url.hostname)).toEqual(['html.duckduckgo.com', 'search.brave.com']);
    expect(fetcher.mock.calls[0]![1].redirect).toBe('error');
  });
  it('rejects oversized pages, reports total failure and preserves cancellation', async () => {
    const fetcher = vi.fn(async () => new Response('x'.repeat(1_000_001)));
    vi.stubGlobal('fetch', fetcher);
    await expect(new BuiltInSearchBackend().search('query')).rejects.toThrow(/exceeds 1 MB/);
    const controller = new AbortController();
    controller.abort();
    fetcher.mockClear();
    await expect(new BuiltInSearchBackend().search('query', 5, controller.signal)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not fall back after the caller cancels a pending request', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetcher);
    const pending = new BuiltInSearchBackend().search('query', 5, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
