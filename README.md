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

Every hit carries a *reference packet* so the agent can decide whether the embedded excerpt is enough or it needs to fetch more:

```jsonc
{
  "path": "01 MASTRA/3. .../Mastra – TypeScript‑фреймворк.md",
  "heading": "#Observability",
  "lines": [120, 168],
  "similarity": 0.742,
  "excerpt": "...",
  "excerpt_truncated": false,
  "vault_name": "Develop"
}
```

| Tool | What it does |
|---|---|
| `get_similar_notes` | Find items similar to a given note. Block granularity by default; switch to `note` for document-level. |
| `search_blocks` | Find blocks similar to an existing block (compound key `path#heading`). |
| `search_notes` | Free-form query search. Modes: `semantic` (Ollama), `keyword` (substring), `hybrid` (RRF fusion). Default: hybrid when Ollama is available, else keyword. |
| `get_embedding_neighbors` | Nearest neighbors for a raw vector. Must match the vault's active dims. |
| `get_connection_graph` | Nested tree (and flat list) of semantically connected notes from a seed. |
| `get_note_content` | Full markdown of a note. Default cap 100 000 chars, `full: true` to disable. Extension whitelist: `.md`, `.markdown`, `.canvas`. |
| `get_block_content` | Markdown of a single heading-scoped block (`block_key` or `{path, heading}`). |
| `resolve_link` | Parse `[[Note#Heading]]` or `obsidian://` URIs to `{path, heading?}`. Does not read the file. |
| `get_stats` | Active model, detected dims, counts, vault info, load statistics. |

## Development

```bash
npm run watch          # tsc --watch
TEST_VAULT_PATH=/abs/path/to/vault npm run smoke
```

`test-bge-m3.mjs` is a 60-check integration smoke test. It requires a Smart-Connections-indexed vault; all Ollama-specific checks are skipped gracefully if no endpoint is reachable.

## Security notes

- **Read-only**: the server never writes to the vault.
- **Path-traversal containment** in `readNoteContent` / `extractBlockContent` — absolute paths, `..`, and symlinks pointing outside the vault are rejected.
- **Extension whitelist**: only `.md` / `.markdown` / `.canvas` are served.
- **Response caps** on note size, excerpt size, graph depth, per-level fanout, and embedding-vector length (must match active dims).
- **Outbound traffic**: none by default. Semantic search is opt-in and only talks to `OLLAMA_HOST` (default `127.0.0.1:11434`). Set `DISABLE_SEMANTIC_SEARCH=1` to hard-disable.

## License

MIT — inherits from the upstream project.
