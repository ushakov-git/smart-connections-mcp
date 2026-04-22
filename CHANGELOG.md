
# Changelog

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
