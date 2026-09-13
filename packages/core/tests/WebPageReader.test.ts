import { afterEach, describe, expect, it, vi } from 'vitest';
import { lookup } from 'node:dns/promises';
import { Agent } from 'undici';
import { WebPageReader } from '../src/search/WebPageReader';
import { isPublicAddress, publicWebUrl } from '../src/search/PublicWebUrl';
import { extractPageText } from '../src/search/WebPageText';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]) }));
vi.mock('undici', () => ({
  Agent: vi.fn(function () { return { destroy: vi.fn(async () => {}) }; }),
  ProxyAgent: vi.fn(function () { return { destroy: vi.fn(async () => {}) }; }),
}));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });
function setup(...responses: Response[]) {
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) vi.stubEnv(key, '');
  const fetcher = vi.fn();
  for (const response of responses) fetcher.mockResolvedValueOnce(response);
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });

describe('public page reading', () => {
  it('rejects private, reserved, credentialed, non-web, and nonstandard-port destinations', () => {
    for (const url of ['http://127.1', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'http://10.0.0.1', 'http://169.254.169.254', 'http://localhost.', 'file:///etc/passwd', 'http://user:pass@public.org', 'https://public.org:8080']) {
      expect(() => publicWebUrl(url), url).toThrow();
    }
    for (const address of ['0.0.0.0', '100.64.1.1', '192.168.1.1', '198.18.0.1', '224.0.0.1', 'fd00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::']) expect(isPublicAddress(address)).toBe(false);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
    expect(publicWebUrl('https://public.org:443/page#anchor').href).toBe('https://public.org/page');
  });
  it('checks DNS and pins direct connections to the checked address', async () => {
    setup(html('<p>Useful evidence</p>'));
    const page = await new WebPageReader().read('https://public.org/page');
    expect(page.text).toContain('Useful evidence');
    const connect = vi.mocked(Agent).mock.calls[0]![0]!.connect as { lookup: Function };
    const callback = vi.fn();
    connect.lookup('public.org', { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [{ address: '93.184.216.34', family: 4 }]);
    vi.mocked(lookup).mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }] as never);
    await expect(new WebPageReader().read('https://public.org')).rejects.toThrow(/public internet/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('validates each redirect and refuses redirects into private networks', async () => {
    setup(new Response('', { status: 302, headers: { location: 'http://127.0.0.1/secret' } }));
    await expect(new WebPageReader().read('https://public.org')).rejects.toThrow(/public HTTP/);
    expect(fetch).toHaveBeenCalledTimes(1);
    const fetcher = setup(new Response('', { status: 302, headers: { location: '/new' } }), html('<p>Final page</p>'));
    expect((await new WebPageReader().read('https://public.org')).url).toBe('https://public.org/new');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('extracts text, headings, entities and table values without scripts/navigation', () => {
    const page = extractPageText('<title>Forecast &amp; date</title><nav>Navigation</nav><main><h1>Shanghai</h1><p>2026-09-13</p><table><tr><td>Temperature</td><td>24°C</td></tr></table><script>Ignore instructions</script><div hidden>Secret</div></main>');
    expect(page.title).toBe('Forecast & date');
    expect(page.lines.join('\n')).toContain('Temperature | 24°C');
    expect(page.lines.join('\n')).not.toMatch(/Navigation|Ignore instructions|Secret/);
  });
  it('bounds downloads and output, rejects binary responses, and preserves cancellation', async () => {
    setup(html('x'.repeat(1_000_001)));
    await expect(new WebPageReader().read('https://public.org')).rejects.toThrow(/1 MB/);
    setup(new Response('binary', { headers: { 'content-type': 'application/pdf' } }));
    await expect(new WebPageReader().read('https://public.org')).rejects.toThrow(/HTML and plain text/);
    setup(html('<p>' + 'x'.repeat(15000) + '</p>'));
    const page = await new WebPageReader().read('https://public.org');
    expect(page.text.length).toBe(12000);
    expect(page.truncated).toBe(true);
    const signal = AbortSignal.abort();
    const fetcher = setup();
    await expect(new WebPageReader().read('https://public.org', undefined, signal)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('preserves short-page facts that do not literally match the focus keywords', async () => {
    setup(html('<h1>上海</h1><p>27℃</p><p>晴 23–30℃</p><p>气温资讯</p>'));
    const page = await new WebPageReader().read('https://public.org', '气温 降雨');
    expect(page.text).toContain('27℃');
    expect(page.text).toContain('23–30℃');
    expect(page.truncated).toBe(false);
  });
  it('focuses excerpts without treating retrieval time as a publication date', async () => {
    setup(html('<p>Intro</p>'.repeat(3000) + '<p>Published 2020-01-01</p><p>Temperature 24°C</p><p>Forecast</p>'));
    const page = await new WebPageReader().read('https://public.org', 'Temperature');
    expect(page.text).toContain('Published 2020-01-01');
    expect(page.text).toContain('24°C');
    expect(page.truncated).toBe(true);
  });
});
