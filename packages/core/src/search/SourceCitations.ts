/** Add presentation metadata only to links backed by this run's web tools. */
export function markSourceCitations(text: string, sourceUrls: readonly string[]): string {
  const normalize = (value: string): string | undefined => {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) return undefined;
      url.hash = '';
      return url.href;
    } catch { return undefined; }
  };
  const sources = new Set(sourceUrls.map(normalize).filter(Boolean));
  if (!sources.size) return text;
  // Consume code first so example links stay literal. Keep unrelated links and
  // existing Markdown titles unchanged; never infer sources from domains alone.
  return text.replace(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|(`+)[\s\S]*?\2)|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (match, code: string | undefined, _ticks: string, label: string, href: string) => {
      if (code || !sources.has(normalize(href))) return match;
      return `[${label}](${href} "source")`;
    });
}
