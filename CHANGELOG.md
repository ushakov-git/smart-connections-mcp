# Changelog

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
