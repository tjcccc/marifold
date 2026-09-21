/** Browser-local acknowledgements, isolated by service/workspace API URL. */
export class SeenRuns {
  private readonly key: string;
  private readonly ids: Set<string>;

  constructor(baseUrl: string) {
    this.key = `marifold.seen-runs.v1:${baseUrl}`;
    let saved: unknown;
    try { saved = JSON.parse(localStorage.getItem(this.key) ?? '[]'); } catch { /* Storage may be unavailable. */ }
    this.ids = new Set(Array.isArray(saved) ? saved.filter(id => typeof id === 'string').slice(-2000) : []);
  }

  has(id: string): boolean { return this.ids.has(id); }

  add(id: string): void {
    this.ids.delete(id);
    this.ids.add(id);
    while (this.ids.size > 2000) this.ids.delete(this.ids.values().next().value!);
    try { localStorage.setItem(this.key, JSON.stringify([...this.ids])); } catch { /* Keep in-memory acknowledgement. */ }
  }
}
