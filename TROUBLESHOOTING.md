# Troubleshooting

The startup log is the primary diagnostic tool. On a healthy run you will see, in order:

```
[smart-connections-mcp] active model: model_key="bge-m3:latest" provider="ollama" full_key="ollama#1776670752600" dims=1024 resolution=default-model-key
[smart-connections-mcp] sources: 140 kept / 8 replaced / 3 no-embedding / 0 null-path / 0 parse-errors (from 140 .ajson files)
[smart-connections-mcp] blocks:  11686 kept / 12 replaced / 9357 no-embedding / 0 bad-key
[smart-connections-mcp] semantic search: Ollama healthy — host="http://localhost:11434" model="bge-m3:latest" dims=1024
[smart-connections-mcp] ready — vault="Develop" path="..." model="bge-m3:latest" dims=1024 sources=140 blocks=11686 semantic=on
[watcher] started — multi=true models=true root=true
[smart-connections-mcp] running on stdio
```

## Symptom → cause

### `Could not resolve active embedding model`

The server found `.smart-env/` but couldn't pick a model. Check in order:

1. Is `smart_env.json → embedding_models.default_model_key` present? Open the Smart Connections settings once in Obsidian; it is written on first use.
2. If you want to override, set `SMART_EMBED_MODEL_KEY` to either the full key (e.g. `ollama#1776670752600`) or the bare `model_key` (`bge-m3:latest`).
3. Verify `.smart-env/embedding_models/embedding_models.ajson` lists the model. If missing, you're on an older plugin layout — set `SMART_EMBED_MODEL_KEY` explicitly.

### `WARNING: 0 sources matched active model "X"`

All source entries have embeddings under a different model than the one resolved. This happens after you change the plugin's model — old notes still carry the old embedding. Either re-embed in Obsidian, or set `SMART_EMBED_MODEL_KEY` to the model that actually indexed the notes.

### Search returns `mode="keyword"` even though you asked for semantic

`meta.warnings` tells you why. Common causes:

- **Ollama unreachable.** Check `curl http://localhost:11434/api/tags`.
- **Model not pulled.** `ollama pull bge-m3:latest`.
- **Dims mismatch.** The Ollama model produced a vector of a different length than what's in the vault. Re-embed in Obsidian against the same Ollama model, or change `OLLAMA_EMBED_MODEL`.
- **Explicitly disabled.** `DISABLE_SEMANTIC_SEARCH=1`.

### `Ollama returned N-d vector, expected M` at query time

Configuration drift. The Ollama-side model no longer matches the one used by the vault. The server refuses to silently produce nonsense cosine scores — pick one side as canonical and re-embed/re-configure the other.

### `Path escapes vault root` / `File extension "..." is not permitted`

The tool call was asked to read something outside the vault, or a non-notebook file. This is intentional — see the Security notes in README. If you genuinely need to serve additional file types, extend the whitelist in `src/smart-connections-loader.ts`.

### Graph has only `connections` and no `tree`

You're consuming an outdated build. Rebuild with `npm run build`; v2 always returns both fields.

### Watcher never reloads after re-embedding

- Confirm `meta.total_notes` / `total_blocks` reflect the expected counts via `get_stats`.
- On Linux, `fs.watch` can miss events on network/Dropbox volumes. As a workaround, call any tool that triggers a response — the loader isn't lazy, but an explicit SIGHUP-style reload tool can be added if needed. For now, restart the MCP client.
- To hard-disable the watcher (e.g. if the vault is on a flaky network share): `DISABLE_WATCHER=1`.

### Server not appearing in Claude Desktop

- JSON in the config is valid (no trailing commas).
- Paths are absolute.
- Fully quit Claude Desktop (Cmd+Q) and relaunch.
- Inspect logs at `~/Library/Logs/Claude/` on macOS.

### High startup latency

140 notes and 12k blocks load in well under a second. If you're seeing multi-second startup:

- Vault has tens of thousands of blocks — expected, linear scan. Not a bug; consider raising `smart_blocks.min_chars` in Obsidian so fewer micro-blocks are indexed.
- Semantic probe is waiting for Ollama. The probe is 10 s max. Unset `OLLAMA_HOST` (or `DISABLE_SEMANTIC_SEARCH=1`) if you don't want the wait.
