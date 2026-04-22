
# Changelog

## v2.2.2 — 2026-04-23

Patch release. Raises the `get_note_content` cap to fit 1M-context
models (Opus 4.7). Additive; no breaking changes.

### Changes

- **Default `MAX_NOTE_CONTENT_CHARS`: 200 000 → 1 000 000 characters.**
  Roughly 250–330k tokens of Cyrillic markdown — comfortably inside a
  1M-token context window. `full: true` on `get_note_content` still
  disables the cap entirely.
- **New env `MAX_NOTE_CONTENT_CHARS`.** Configurable per-install,
  range 1 000 – 50 000 000. Invalid values fall back to the default
  and log a warning, matching the behaviour of the other env knobs.
- Startup log reports the resolved cap and whether it came from env
  or default, e.g.
  `[smart-connections-mcp] note_content_cap=1000000 chars (default)`.

### Independent from client token-limit

The MCP client's own per-response token limit is a separate
constraint and the server cannot influence it. If Claude Code (or
any other client) truncates a response before the server cap would,
raising `MAX_NOTE_CONTENT_CHARS` will not help. For that scenario:
prefer `get_block_content` (section-level chunking via heading
boundaries) or keep an eye on the v2.3.0 backlog where a
`get_note_content_chunk` tool is tracked.

---

## v2.2.1 — 2026-04-23

Patch release driven by live testing on a real vault
(`test-reports/TESTING_REPORT_v2.2.0.md`). All three findings from
that report are resolved; functionality is additive except for one
default-value change, noted below.

### Response-size controls (breaking default)

Large vaults were producing `get_similar_notes(granularity: "note")`
and `get_note_content` responses that exceeded the MCP client token
limit. Each note-level hit carried a full `blocks[]` list of heading
keys, which on notes with 100+ headings dominated the payload.

- **`get_similar_notes`, `search_notes`, `get_embedding_neighbors`**
  gain `include_blocks_list` (default **`false`**) and
  `max_blocks_per_hit` (default `30`, cap `500`). **Breaking
  default:** note-granularity hits no longer ship with `blocks[]`
  unless opted in. Pass `include_blocks_list: true` to restore the
  old shape; when the list is included it is capped, with
  `blocks_truncated: true` + `total_blocks_in_note` set.
- **`get_note_content`** gains `include_blocks_list` (default
  `true` — back-compat) and `max_blocks` (default `150`, cap
  `2000`). Huge notes no longer stuff hundreds of heading keys
  into the JSON reply; the trim is flagged via `blocks_truncated`
  and the full count via `total_blocks_in_note`.
- `search_blocks` is unchanged — it is block-only and never carried
  the list.

### Error-message parity

- **`get_block_content`** now throws `"Block not found: <key>"` on
  an unknown heading, matching the wording documented in the
  README and CHANGES. Previously the server threw "Block line
  range unknown for ..." while docs promised the other form —
  resolved.

### Tests

- Smoke suite 73 → 86 checks. New coverage: unified "Block not
  found" message, `include_blocks_list` default-off and opt-in
  behaviour, `max_blocks` truncation in `get_note_content`,
  `expand_to_section: "always"`, `DISABLE_SEMANTIC_SEARCH`
  fallback path (via engine built without Ollama), and all three
  path-traversal classes through `readNoteContent`.

### Migration

Callers that relied on `blocks[]` in note-granularity search
results must now pass `include_blocks_list: true` explicitly. In
practice this surface was rarely used — the field duplicated the
same heading list on every hit, and agents already had `path` to
call `get_note_content` when a list was actually wanted.

---

## v2.2.0 — 2026-04-22

Incremental. No breaking changes to existing fields; additive only.
Focused on closing the agent-UX gap surfaced by live testing: block
hits were technically correct but the payload was too shallow, and
the hybrid similarity scale confused consumers.

### Search post-processing

- **`expand_to_section` (new parameter, default `"high-similarity"`).**
  Block-level hits are now auto-enriched with full parent-section
  markdown in `section_content`, plus `section_heading` /
  `section_lines` / `expansion`. Triggers:
  - heading ends with `#{N}` fragment suffix (always expand — those
    are topic-phrases without enough content in the excerpt);
  - cosine similarity ≥ `expand_threshold` (default 0.8);
  - mode `"always"` forces expansion on every block hit.
  In hybrid mode the expand decision uses the pre-fusion cosine, not
  the RRF score — so `0.8` remains cosine-native across modes.
  Section content is capped by `expand_max_chars` (default 5000),
  with `expansion.truncated_to_max_chars` surfacing the truncation.
- **`deduplicate_by_section` (new parameter, default `true`).**
  Block-level hits that share the first N heading segments (N=2 by
  default, 3 also supported via `dedup_level`) are collapsed: the
  best-similarity hit is kept; dropped siblings move into its
  `sibling_matches`. Fixes the common case where top-5 is four slots
  from the same `##`-section.
- **Parent-block lookup** walks the heading chain by peeling the
  trailing `#segment` (or `#{N}`) off the compound key and probing
  the block index until a known ancestor is found.

### Hybrid scoring

- **`rank_score` and `raw_rrf_score` (new fields, hybrid-only).**
  The raw RRF score lives in an awkward ~0.005–0.02 range and was
  misread by agents as "low confidence". Every hybrid hit now also
  carries `rank_score` (RRF divided by top-1 RRF in the response, so
  top-1 is 1.0 and the scale is hybrid-native) and `raw_rrf_score`
  for diagnostic clarity. `similarity` is unchanged for back-compat.

### Fuzzy heading lookup

- **`get_block_content` and `search_blocks`** now retry on exact
  miss using a whitespace- and case-insensitive normalization scoped
  to the note's blocks. On single-match resolution the response
  carries the canonical key and `warnings: ["fuzzy-matched: ..."]`.
  Ambiguous matches throw with the candidate list so the agent can
  disambiguate instead of the server silently picking one. Fixes the
  recurring "search_notes emits a heading, search_blocks can't find
  it" failure.

### Defaults and limits

- Default `excerpt_chars` **500 → 1500**. On typical `##`-blocks of
  3–6k characters, 500 covered 8–16 %; 1500 reaches 25–50 %.
- `MAX_NOTE_CONTENT_CHARS` cap **100 000 → 200 000**. Long
  reference notes commonly exceed 100k; `full: true` still disables
  the cap entirely.

### Descriptions

- `search_notes` description now warns that in hybrid mode
  `similarity` is an RRF score (~0.01), not cosine, and that
  `threshold` applies pre-fusion to the semantic component only.
- `get_note_content` description emphasizes checking `meta.truncated`
  and using `full: true` for long notes.
- `get_block_content` description mentions the fuzzy-lookup fallback.

### New meta fields

- `meta.expansion` — `{ mode, threshold, max_chars, applied_count,
  skipped_count }` when the expand pass ran.
- `meta.dedup` — `{ enabled, level, groups_collapsed }` when dedup
  ran.

### Skill

- `.claude/skills/obsidian-knowledge-search/SKILL.md` — a Claude Code
  agent skill that documents the 9-tool surface, the three block
  levels, similarity scales, post-processing semantics, and four
  worked examples. Symlink into `~/.claude/skills/` to make it
  visible from any cwd (instructions in README).

### Tests

Smoke suite grew from **63** to **73** assertions, covering
fragment auto-expand, expand "never" pass-through, dedup sibling
collapsing, hybrid `rank_score` normalization, and fuzzy heading
resolution.

## v2.1.0 — 2026-04-22

Incremental. No breaking changes.

- **Weighted hybrid RRF.** Hybrid `search_notes` now uses
    `score(doc) = w_sem · rrf_sem(doc) + w_kw · rrf_kw(doc)`.
  Defaults `w_sem = 0.7`, `w_kw = 0.3` tilt results toward the
  embedding ranking by default — the keyword list still contributes
  as a safety net for rare names, quotations and acronyms.
- **Configurable RRF.** New env vars `RRF_K` (smoothing, default 60),
  `RRF_SEMANTIC_WEIGHT` (0.7), `RRF_KEYWORD_WEIGHT` (0.3). The
  *k*-parameter is a smoothing constant applied symmetrically to
  both lists, so changing *k* alone does **not** shift the
  semantic/keyword balance — the weights are the real lever.
- **Meta exposes fusion.** Every response's `meta` now carries
  `fusion: { k, semantic_weight, keyword_weight }` so an agent (or
  operator) can see which config produced the ranking.
- **Docs.** README.md / README_rus.md updated with the env table
  entries and an explicit note that *k* doesn't shift balance.
- **`.mcp.json` template** committed into the reference vault as a
  copy-paste starting point for new vaults.

## v2.0.0 — 2026-04-21

Breaking rework of the original `smart-connections-mcp`. Private fork;
not published upstream.

### Highlights

- **Works with current Smart Connections format.** Active model is
  resolved via `embedding_models.default_model_key` (new-format plugin)
  with optional `SMART_EMBED_MODEL_KEY` override. Runtime dims detection
  — the plugin's metadata `dims` is known to lie (e.g. bge-m3 records
  384 but emits 1024).
- **Block-level semantic results.** The `smart_blocks:` entries inside
  `multi/*.ajson` are now indexed. Hits carry `path`, `heading`,
  `lines`, `excerpt`, `vault_name` — enough for the agent to use the
  excerpt directly or follow up via `get_block_content`.
- **Opt-in Ollama semantic search** for `search_notes`. Modes:
  `semantic`, `keyword`, `hybrid` (RRF k=60). Graceful fallback to
  keyword with a visible warning. LRU cache for query → vector.
- **Hot reload.** `fs.watch` on `.smart-env/multi/` + debounced
  incremental reload; full reload on `smart_env.json` /
  `embedding_models/` changes.
- **Graceful shutdown** on SIGINT/SIGTERM.
- **Security hardening.** Path-traversal containment (`..`, absolute,
  symlink-escape), extension whitelist (`.md` / `.markdown` /
  `.canvas`), response size caps, vector-dim guard.
- **`resolve_link` tool** for wikilinks and `obsidian://` URIs.

### New tools

- `search_blocks`
- `get_block_content`
- `resolve_link`

### Changed tools

- `get_similar_notes` — default `granularity: "block"`. Hits now carry
  the reference packet.
- `get_connection_graph` — returns both the legacy flat `connections`
  list and a nested `tree`.
- `search_notes` — new `mode` / `granularity` / `include_excerpt` /
  `excerpt_chars`. Description rewritten to reflect the three modes.
- `get_note_content` — `full: true` to disable the 100 000-char cap.
- `get_embedding_neighbors` — rejects vectors of wrong dims.
- `get_stats` — returns active model, detected dims, totals, vault
  info, load statistics.

### Breaking

- Legacy `smart_sources.embed_model` resolution path removed.
- `dist/` removed from git; run `npm run build` before use.
- Every tool response now has a `meta` envelope.

### Security posture

- Read-only filesystem access, restricted to the vault.
- The only outbound network call is to `OLLAMA_HOST` (default
  `127.0.0.1:11434`). Disable with `DISABLE_SEMANTIC_SEARCH=1`.
- Zero new runtime deps — only `@modelcontextprotocol/sdk` and `zod`
  remain.
