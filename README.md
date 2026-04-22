# Smart Connections MCP Server — v2

An MCP server that exposes an Obsidian vault indexed by the
[Smart Connections](https://github.com/brianpetro/obsidian-smart-connections)
plugin to any MCP client (Claude Desktop, Claude Code, ...).

v2 is a fork focused on:
- working with **current** Smart Connections format (including Ollama-backed models like `bge-m3`),
- **block-level** semantic results with a reference packet (`path`, `heading`, `lines`, `excerpt`),
- **optional** semantic query search via a local Ollama endpoint,
- **hot reload** when the plugin re-embeds in the background,
- sensible security defaults (path-traversal containment, extension whitelist, response size caps).

## Requirements

- Node.js 18+ (built-in `fetch`, `AbortController`).
- An Obsidian vault already indexed by Smart Connections — i.e. `<vault>/.smart-env/` exists and contains at least `smart_env.json`, `multi/*.ajson`, and (for new-format vaults) `embedding_models/embedding_models.ajson`.
- For semantic `search_notes`: an Ollama server running locally with the **same** embedding model Smart Connections used (e.g. `bge-m3:latest`). Semantic is opt-in and the server falls back to keyword matching if Ollama is unreachable or dims mismatch.

## Install

```bash
git clone https://github.com/ushakov-git/smart-connections-mcp.git
cd smart-connections-mcp
npm install
npm run build
```

`dist/` is not committed — always build from source.

## Configure (Claude Desktop example)

```json
{
  "mcpServers": {
    "smart-connections-develop": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/smart-connections-mcp/dist/index.js"],
      "env": {
        "SMART_VAULT_PATH": "/Users/me/Vaults/Develop",
        "SMART_VAULT_NAME": "Develop"
      }
    }
  }
}
```

Register a separate MCP server per vault. `SMART_VAULT_NAME` is echoed in every response's `meta.vault_name`, so the agent can tell results apart when multiple vault-servers are active.

### Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `SMART_VAULT_PATH` | Absolute path to the vault root. | *required* |
| `SMART_VAULT_NAME` | Label used in response `meta.vault_name`. | `basename(SMART_VAULT_PATH)` |
| `SMART_EMBED_MODEL_KEY` | Force a specific embedding model key. Accepts full `provider#ts` or bare `model_key`. | resolved from `smart_env.json` |
| `OLLAMA_HOST` | Enables semantic search when set. | `embedding_models.ajson.host` if present |
| `OLLAMA_EMBED_MODEL` | Model name Ollama should use. | active `model_key` |
| `DISABLE_SEMANTIC_SEARCH` | `1` to skip Ollama even if configured. | unset |
| `DISABLE_WATCHER` | `1` to skip the filesystem watcher. | unset |
| `RRF_K` | Smoothing constant for hybrid RRF. Applied to both lists, so changing it does **not** shift the semantic/keyword balance — it only flattens the score curve. | 60 |
| `RRF_SEMANTIC_WEIGHT` | Weight of the semantic ranked list in the fused score. Increase to let embeddings dominate. | 0.7 |
| `RRF_KEYWORD_WEIGHT` | Weight of the keyword ranked list in the fused score. Increase for rare names/quotations/acronyms. | 0.3 |
| `MAX_NOTE_CONTENT_CHARS` | Upper bound in characters on the `get_note_content` payload. `full: true` still disables the cap entirely. Range 1 000 – 50 000 000. | 1 000 000 (v2.2.2) |

A `.env` file placed next to the server's cwd is auto-loaded. Values provided in the MCP client config always win.

## Tools

All responses are JSON text with this shape:

```jsonc
{
  "meta": {
    "vault_name": "Develop",
    "model_key": "bge-m3:latest",
    "dims": 1024,
    "semantic_available": true,
    "total_notes": 140,
    "total_blocks": 11686,
    "execution_ms": 37
    // plus search_mode / fallback_from / warnings when relevant
  },
  "results": [ ... ]
}
```

Every hit carries a *reference packet* so the agent can decide whether the embedded excerpt is enough or it needs to fetch more. For high-similarity block hits (and for any `#{N}` fragment) the server also attaches the full parent-section markdown:

```jsonc
{
  "path": "01 MASTRA/3. .../Mastra – TypeScript‑фреймворк.md",
  "heading": "#Observability#{1}",
  "lines": [120, 125],
  "similarity": 0.842,
  "excerpt": "...",                  // up to excerpt_chars (default 1500)
  "excerpt_truncated": false,
  "vault_name": "Develop",

  // v2.2.0: appear when the server expands the hit to its parent section
  "section_content": "...",          // full markdown, capped by expand_max_chars
  "section_heading": "#Observability",
  "section_lines": [115, 200],
  "expansion": {
    "applied": true,
    "reason": "fragment auto-expand",
    "original_heading": "#Observability#{1}",
    "truncated_to_max_chars": false
  },

  // v2.2.0: appear when dedup collapses neighbors from the same section
  "sibling_matches": [
    { "heading": "#Observability#Trace export", "similarity": 0.79, "lines": [180, 195] }
  ],

  // v2.2.0: hybrid mode only
  "rank_score": 1.0,
  "raw_rrf_score": 0.0164
}
```

### Post-processing knobs (v2.2.0)

`search_notes`, `get_similar_notes`, `search_blocks`, and `get_embedding_neighbors` accept these extra parameters:

| Parameter | Default | Effect |
|---|---|---|
| `expand_to_section` | `"high-similarity"` | How aggressively to enrich block hits with full parent-section markdown. `"never"` keeps only the excerpt; `"always"` expands every block hit; `"high-similarity"` expands when the cosine score ≥ `expand_threshold` OR the heading ends with `#{N}`. |
| `expand_threshold` | `0.8` | Cosine similarity cut-off for the high-similarity mode. In hybrid this is compared against the pre-fusion cosine, not the RRF score. |
| `expand_max_chars` | `5000` | Cap on `section_content` size; truncation is reported via `expansion.truncated_to_max_chars`. |
| `deduplicate_by_section` | `true` | Group hits that share the first N heading segments and keep only the best-similarity one; the rest move into `sibling_matches`. |
| `dedup_level` | `2` | Number of leading heading segments that define a "section" for dedup. `2` matches `##` granularity (default — widest coverage), `3` matches `###`. |
| `include_blocks_list` (v2.2.1) | `false` (search), `true` (`get_note_content`) | Attach the full heading-key list (`blocks[]`) to note-granularity hits / note-content responses. Default-off on search hits because a single large note can carry hundreds of keys that blow past the MCP client token limit. Enable explicitly when you need to enumerate subsections. |
| `max_blocks_per_hit` (v2.2.1) | `30` | Upper bound on `blocks[]` length per note-granularity hit when the list is opted in. Extra keys are dropped and `blocks_truncated: true` + `total_blocks_in_note` are set. `get_note_content` uses `max_blocks` (default `150`) instead. |

The `meta` reports what the post-processor did: `meta.expansion = { mode, threshold, max_chars, applied_count, skipped_count }` and `meta.dedup = { enabled, level, groups_collapsed }`.

| Tool | What it does |
|---|---|
| `get_similar_notes` | Find items similar to a given note. Block granularity by default; switch to `note` for document-level. |
| `search_blocks` | Find blocks similar to an existing block (compound key `path#heading`). |
| `search_notes` | Free-form query search. Modes: `semantic` (Ollama), `keyword` (substring), `hybrid` (RRF fusion). Default: hybrid when Ollama is available, else keyword. |
| `get_embedding_neighbors` | Nearest neighbors for a raw vector. Must match the vault's active dims. |
| `get_connection_graph` | Nested tree (and flat list) of semantically connected notes from a seed. |
| `get_note_content` | Full markdown of a note. Default cap **1 000 000 chars** (~250-330k tokens of Cyrillic markdown; v2.2.2 default, was 200 000). Override per-install via env `MAX_NOTE_CONTENT_CHARS`. `full: true` disables the cap entirely. Extension whitelist: `.md`, `.markdown`, `.canvas`. Independent from the MCP client's per-response token limit, which the server cannot influence. |
| `get_block_content` | Markdown of a single heading-scoped block (`block_key` or `{path, heading}`). On exact miss retries with a whitespace/case-insensitive normalization and reports the canonical key via `warnings`. |
| `resolve_link` | Parse `[[Note#Heading]]` or `obsidian://` URIs to `{path, heading?}`. Does not read the file. |
| `get_stats` | Active model, detected dims, counts, vault info, load statistics. |

## Development

```bash
npm run watch          # tsc --watch
TEST_VAULT_PATH=/abs/path/to/vault npm run smoke
```

`test-bge-m3.mjs` is a 70+ integration smoke test. It requires a Smart-Connections-indexed vault; all Ollama-specific checks are skipped gracefully if no endpoint is reachable.

## Agent skill

`.claude/skills/obsidian-knowledge-search/SKILL.md` is a Claude Code skill that teaches the agent how to call these tools effectively — how to read the response envelope, how to interpret the three block levels (`##` / `###` / `#{N}`), the different `similarity` scales across modes, and the post-processing outputs (`section_content`, `sibling_matches`, `rank_score`).

To make the skill discoverable from any working directory, symlink it into your user-level skills dir:

```bash
ln -s \
  "$(pwd)/.claude/skills/obsidian-knowledge-search" \
  ~/.claude/skills/obsidian-knowledge-search
```

The file stays versioned with the repo; the symlink is a local convenience.

## Security notes

- **Read-only**: the server never writes to the vault.
- **Path-traversal containment** in `readNoteContent` / `extractBlockContent` — absolute paths, `..`, and symlinks pointing outside the vault are rejected.
- **Extension whitelist**: only `.md` / `.markdown` / `.canvas` are served.
- **Response caps** on note size, excerpt size, graph depth, per-level fanout, and embedding-vector length (must match active dims).
- **Outbound traffic**: none by default. Semantic search is opt-in and only talks to `OLLAMA_HOST` (default `127.0.0.1:11434`). Set `DISABLE_SEMANTIC_SEARCH=1` to hard-disable.

## License

MIT — inherits from the upstream project.
