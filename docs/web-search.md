# Web search

Web search is enabled by default. Marifold first uses provider-hosted search when
its provider/model capability detection supports that connection. Otherwise it
exposes its own `web_search` tool using the experimental `builtin` backend. No
search provider selection, API key, MCP server, or browser installation is needed.

```toml
[web_search]
enabled = true
provider = "builtin"
max_results = 5
```

Existing explicit `duckduckgo`, `firecrawl`, and `ollama` choices are preserved.
An existing explicit `enabled = false` remains off and now disables native search
as well as fallback search. Remove the section to use defaults, or select
**Built-in — experimental** and turn search on in Config → Web search.
The CLI equivalent is `marifold config search --provider builtin`;
`marifold config search --provider off` disables all search.

Network approval policy still applies. Native search retains its existing
provider request boundary; fallback calls appear as ordinary `web_search` tool
calls. A native capability rejection may retry once through the fallback only
before provider output has been exposed. Authentication, billing, and unrelated
connection errors do not trigger search fallback. A provider-level
`native_web_search = "off"` turns off only that provider's native capability;
the global `[web_search].enabled` switch controls all search.

## Built-in retrieval

The implementation runs locally, but queries are sent to public search engines:

1. Fetch DuckDuckGo's HTML search page and extract organic result entries.
2. If access fails, is blocked, or returns unrecognized markup, try Brave HTML once.
3. Return bounded titles, source URLs, and snippets through the existing tool
   result formatter. Parsing, normalization, and deduplication require no model call.

A recognized empty result is returned as empty; it does not trigger a broader
search on another engine. Failed responses are reported as failures, rather than
being confused with an empty result set. No paid provider is used automatically.

Each engine attempt has a five-second deadline and a 1 MB decoded response cap.
Requests support cancellation, follow no redirects, and use only fixed engine
endpoints. Result URLs are validated HTTP(S) links with no embedded credentials;
the search tool does not open them. The backend keeps at most 32 result sets in
memory for five minutes. Queries are limited to 2,048 characters, results to ten,
titles to 200 characters, URLs to 4,096, and snippets to 600. The normal default is
five results. The existing search proxy setting and proxy environment variables
are respected. Cached results and queries are not written to disk by the backend.

This is experimental: access restrictions and engine markup can change; relevance,
freshness, exact-phrase matching, and site filters are ultimately engine-dependent.
Brave responses that explicitly drop query operators are reported as failures. Search snippets
are external evidence, not instructions, and do not substitute for reading a full
source. The page reader below adds bounded source inspection; browser automation,
MCP, and a local web index remain outside this MVP.

## Search and source inspection

Fallback mode exposes both `web_search` and `read_web_page` in chat and agent
runs. Native search remains first; these tools are hidden while native search is
active, and both honor the global off switch and network policy.

The agent receives the host date/timezone and instructions to choose useful
keywords, inspect promising sources, check dates, refine insufficient searches,
and cite the facts it actually found. Both native and fallback answers should
lead with the requested facts in the user's language, using brief conversational
prose and an unobtrusive parenthetical source link, such as
`（来源：[Source name](URL)）` in Chinese or `(Source: [Source name](URL))` in English.
Brief attribution such as “According to the
weather site” is fine. Routine search narration and lists of sites
belong outside the final answer unless the user asks for research details.
Forecasts, current readings, and material uncertainty remain distinct.
Choosing a public result is part of the requested research; normal network tool
approval still applies. Search snippets and page text are untrusted data.

Each run permits at most three searches and three page reads. Identical queries
and identical URL/focus reads are skipped. If the model tries to finish after finding sources without attempting a page
read, the agent runner opens the top returned source once through the ordinary
page tool. Its real tool call and result are recorded, and the model receives
that evidence before answering. A denied read is respected; this does not bypass
approval or extend the existing iteration limit. Chat uses the same tools and
guidance, without this agent-only automatic source inspection. Empty model responses also receive one
bounded retry from existing evidence; repeated empty responses fail explicitly
instead of being marked completed. Source freshness/relevance is assessed
by the model, so the workflow does not guarantee perfect judgment or citations.

`read_web_page` accepts a URL and optional short `focus` keywords. It preserves
page text, headings, table cells, and date metadata, and returns the source URL,
retrieval timestamp, and up to 12,000 characters. Retrieval time is explicitly
separate from publication time. Short pages are returned intact even when focus keywords are supplied. Focus
selects contextual excerpts only when the full text exceeds the output limit; it
is not a full-document search interface. No scripts, cookies, login, iframe loads, or other
subresource requests are executed. Pages requiring JavaScript may remain unusable.

A read has a ten-second deadline including DNS and up to three redirects, with a
1 MB decoded response limit. Only HTML/plain text at public HTTP(S) URLs on standard
ports is accepted; embedded credentials, local names, private/reserved addresses,
and redirects to them are rejected. Direct connections pin validated DNS answers.
With an explicitly configured or environment-provided proxy, that trusted proxy
owns final DNS resolution and destination routing; configure it to prohibit access
to private destinations. Validation on the host cannot inspect the proxy's remote
DNS answers. No proxy credentials are forwarded to source sites.

Run the local-model research evaluation after building:

```sh
node scripts/search-research-eval.mjs
node scripts/search-research-eval.mjs --fixture
```

The live weather case records page evidence and agent events in ignored
`output/search-benchmark-research-*.json` files. The explicitly prompted fixture
case uses synthetic, dated weather pages to probe stale-source recovery; its
values are not real weather observations. Both use disposable workspace state
and the selected local Ollama model. Fixtures test tool behavior, not live search
quality. Compare the recorded evidence with the final answer instead of counting
successful tool calls as task success.

## Service proxy troubleshooting

The service uses its own process environment. A proxy exported in an interactive
shell may be absent from a desktop-launched or managed service. If search works
in the terminal but the service reports `fetch failed`, set the actual proxy URL
in Config → Web search → Proxy. The displayed example is only a placeholder.
Saving through the local Web UI rebuilds the search backend immediately; the
setting also survives service restarts. A loopback proxy must run on the host.

In the Shanghai-weather failure investigated on 2026-09-13, both direct engine
requests timed out (`ETIMEDOUT`), while the same query through the host's existing
proxy returned five results. The service lacked the shell's proxy environment;
saving its explicit search proxy resolved that configuration difference.

## Engine feasibility

The 2026-09-13 development-network probes covered these mainstream engines:

| Engine | Observation | MVP decision |
| --- | --- | --- |
| DuckDuckGo | HTML results work for ordinary queries; some requests hit a challenge | Primary engine |
| Brave | Extractable HTML; sometimes relaxes strict operators | Fallback; reject explicitly relaxed queries |
| Bing | RSS is extractable but returned unrelated results for several exact queries | Excluded after quality review |
| Google | JavaScript retry page | Excluded |
| Baidu | Verification response | Excluded |

These are network-specific observations, not claims of universal accessibility.
The MVP does not bypass challenges. An engine markup change may require a parser
update; a failed strict query can be retried with different keywords by the caller.

## Reproducible evaluation

Build first, then run the fixed 30-query English/Chinese comparison:

```sh
pnpm --filter @marifold/core build
node scripts/search-benchmark.mjs --providers builtin,duckduckgo,firecrawl
```

Queries live in `scripts/search-queries.json`: documentation, troubleshooting,
exact phrases, site filters, dated questions, ambiguity, and negative controls.
Update dated cases intentionally when repeating in later months. `--count 6`
runs an initial smoke batch; `--output <path>` chooses the JSON report location.
The default report is `output/search-benchmark.json` (ignored by Git).

Each provider receives the same query and five-result limit, with rotated provider
order and fresh backend instances so the report measures uncached retrieval.
Requests run serially with a one-second pause; latency includes failures. Firecrawl
uses search-only mode and is skipped without `FIRECRAWL_API_KEY`. The default
provider list is built-in plus DuckDuckGo, so paid search is opt-in for the harness.

Reports include result content, errors, response bytes, median/p95 latency, and
retrieval success. Bytes are not token counts. Review relevance, authoritative
sources, dates, and source coverage separately; matching another backend's ranking
is not a correctness criterion. Do not compare successful answers with quick
failure responses as if the latter represented faster equivalent work.

Run an end-to-end local-model smoke test, using only disposable temporary state:

```sh
node scripts/search-agent-eval.mjs --model gemma4:e4b-mlx
```

It compares built-in and legacy DuckDuckGo search using identical English/Chinese
objectives, saves tool events, usage, and answer timings to
`output/search-benchmark-agent.json`, and removes temporary profiles/sessions.
No real workspace data is read. An available local Ollama model is required;
use `--providers builtin` to test only the new backend. The harness rejects model
names containing `cloud` but the configured local server remains responsible for
how its model aliases execute. Inspect the results; the smoke test records evidence
and does not automatically grade answer correctness.

Offline regressions cover HTML/entity extraction, redirects, ads, duplicate links,
blocked/changed pages, genuine empty responses, bounded reads, timeouts,
cancellation, caching, default selection, explicit providers, and the global off
switch. The full repository validation gate remains required for a milestone.

## MVP evaluation results — 2026-09-13

The final DuckDuckGo HTML → Brave HTML run returned results for 12/30 queries
(median 1,013 ms, p95 1,513 ms across all attempts). Most failures were DuckDuckGo
challenges and Brave HTTP 429 responses after repeated development probes. One
strict query failed because Brave explicitly dropped its operators. The earlier
legacy DuckDuckGo run failed 30/30 requests on this network. These samples were
run at different times and are not a controlled ranking or speed comparison.
Firecrawl was not measured because its API key was unavailable.

Manual source review found relevant official Fastify, Fedora, Python, and
PostgreSQL links among successful results. Saved Brave pages also parsed the
expected MDN AbortSignal and Python pathlib sources; its relaxed negative-control
response was rejected. Dated-query freshness and site-filter coverage remain
unverified where retrieval failed. Earlier Bing RSS results were discarded after
inspection found unrelated hits; nonempty output alone is not success.

A local `gemma4:e4b-mlx` agent completed both English Node.js release and Chinese
Python documentation objectives with a single built-in search, an official URL,
and a supported fact. End-to-end times were approximately 17.0 s and 9.5 s, with
reported input/output tokens of 5,538/96 and 5,470/83. This used the unchanged
primary DuckDuckGo HTML path before the final fallback revision. The equivalent
legacy DuckDuckGo searches failed and the model reported failure. Native routing
was regression-tested with mocked provider responses, not paid live calls.

The built-in parser itself uses no model tokens. Search snippets still enter the
model context and an agent search ordinarily requires another model round trip;
these measurements do not isolate that incremental cost from the agent's base
prompt. Engine availability is the main unresolved MVP limitation.

## Source-following evaluation — 2026-09-13

The final local `gemma4:e4b-mlx` weather run used one search and one page read in
about 26.1 seconds. Its reported temperature values were present in the captured
page text, and it linked the source. It still answered in English to a Chinese
prompt and overstated the absence of rain from incomplete evidence. This checks
source access and use, not independently verified current weather accuracy.

Earlier runs revealed premature stopping and duplicate page reads, addressed
with automatic source inspection and the duplicate guard. A synthetic stale-page probe
still showed weak recovery: the model read the old source and stopped instead of
reliably seeking current fixture data. Prompting alone does not guarantee good
judgment; the fixture harness retains this case as a regression probe. Offline
checks verify tool bounds, page validation/extraction, native/off routing, and
continuation behavior including declined page reads.

A later user run ignored the prompt-only reminder to read a source. The runner
now performs that one read through normal approval rather than relying on another
model instruction. A second regression removed unlabeled temperatures when focus
keywords were supplied; short pages now retain their complete text. The follow-up
live Gemma run returned a brief Chinese forecast with a source link and values
present in the page. Attribution and redundant reading still varied; this is not
a guarantee of consistent model behavior across prompts and conversation history.

### MVP acceptance and remaining relevance issues

The experimental MVP supports keyless retrieval, bounded source reading, and
natural cited answers. Successful tool execution does not verify the answer's
location or date. In follow-up user testing, a request for Xi’an weather was
answered as Shanghai; whether the mismatch came from the query, source selection,
or final synthesis has not been established. Relative-date news answers also
used an ambiguous search-snapshot date. Latest-request location matching and
source-date verification remain follow-up work, alongside engine availability.
