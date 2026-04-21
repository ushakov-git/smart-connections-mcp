#!/usr/bin/env node
/**
 * Smart Connections MCP Server — entry point.
 *
 * Bridges an MCP client (Claude Code, Claude Desktop, ...) to a local
 * Obsidian vault indexed by the Smart Connections plugin. All data is
 * read from `<vault>/.smart-env/`; no network calls are made by default.
 * See README for the full set of tools and their contract.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { loadDotEnv } from './env-loader.js';
import { SmartConnectionsLoader } from './smart-connections-loader.js';
import { SearchEngine } from './search-engine.js';
import { OllamaClient } from './ollama-client.js';
// --------------------------------------------------------------- bootstrap
const dotenv = loadDotEnv();
if (dotenv.loaded) {
    console.error(`[smart-connections-mcp] loaded .env from ${dotenv.path} (${dotenv.keys.length} new vars)`);
}
const VAULT_PATH = process.env.SMART_VAULT_PATH;
if (!VAULT_PATH) {
    console.error('Error: SMART_VAULT_PATH environment variable is required.');
    console.error('Set it via the MCP client config (env) or in a .env file next to the server cwd.');
    process.exit(1);
}
const VAULT_NAME = process.env.SMART_VAULT_NAME?.trim() ||
    (VAULT_PATH.split('/').filter(Boolean).pop() ?? 'vault');
const loader = new SmartConnectionsLoader(VAULT_PATH);
await loader.initialize();
const activeModel = loader.getActiveModel();
// -- Optional semantic search via Ollama ------------------------------------
// Opt-in: only enabled if OLLAMA_HOST is set (either explicitly or via the
// embedding_models.ajson `host` for this model) AND DISABLE_SEMANTIC_SEARCH
// is not "1". We probe the endpoint once and install the client only when
// the dims match the vault — mismatched dims would silently destroy cosine
// scoring, so we refuse that case.
const semanticDisabled = process.env.DISABLE_SEMANTIC_SEARCH === '1';
const ollamaHost = (process.env.OLLAMA_HOST ?? activeModel.host ?? '').trim();
const ollamaModel = (process.env.OLLAMA_EMBED_MODEL ?? activeModel.model_key).trim();
let ollamaClient = null;
if (semanticDisabled) {
    console.error('[smart-connections-mcp] semantic search disabled (DISABLE_SEMANTIC_SEARCH=1)');
}
else if (!ollamaHost) {
    console.error('[smart-connections-mcp] semantic search: no OLLAMA_HOST and no host in embedding_models.ajson — using keyword only.');
}
else {
    const probe = new OllamaClient({
        host: ollamaHost,
        model: ollamaModel,
        expectedDims: activeModel.dims,
    });
    const health = await probe.health();
    if (health.reachable && health.modelAvailable && health.dimsMatch) {
        ollamaClient = probe;
        console.error(`[smart-connections-mcp] semantic search: Ollama healthy — host="${ollamaHost}" model="${ollamaModel}" dims=${health.observedDims}`);
    }
    else {
        console.error(`[smart-connections-mcp] semantic search: Ollama probe failed — reachable=${health.reachable} ` +
            `modelAvailable=${health.modelAvailable} dimsMatch=${health.dimsMatch} ` +
            `observedDims=${health.observedDims} error=${health.error ?? 'n/a'}`);
    }
}
const searchEngine = new SearchEngine(loader, VAULT_NAME, ollamaClient);
console.error(`[smart-connections-mcp] ready — vault="${VAULT_NAME}" path="${VAULT_PATH}" ` +
    `model="${activeModel.model_key}" dims=${activeModel.dims} ` +
    `sources=${loader.getSources().size} blocks=${loader.getBlocks().size} ` +
    `semantic=${ollamaClient ? 'on' : 'off'}`);
// ---------------------------------------------------------------- limits
const MAX_NOTE_CONTENT_CHARS = 100_000;
const MAX_EXCERPT_CHARS_CAP = 5_000;
const MAX_DEPTH = 4;
const MAX_PER_LEVEL = 25;
const MAX_LIMIT = 100;
// ---------------------------------------------------------------- schemas
const Granularity = z.enum(['note', 'block']);
const GetSimilarNotesSchema = z.object({
    note_path: z.string().min(1).max(1024),
    threshold: z.number().min(0).max(1).default(0.5),
    limit: z.number().int().positive().max(MAX_LIMIT).default(10),
    granularity: Granularity.default('block'),
    include_excerpt: z.boolean().default(true),
    excerpt_chars: z.number().int().positive().max(MAX_EXCERPT_CHARS_CAP).default(500),
});
const SearchBlocksSchema = z.object({
    block_key: z.string().min(3).max(2048),
    threshold: z.number().min(0).max(1).default(0.5),
    limit: z.number().int().positive().max(MAX_LIMIT).default(10),
    include_excerpt: z.boolean().default(true),
    excerpt_chars: z.number().int().positive().max(MAX_EXCERPT_CHARS_CAP).default(500),
});
const GetConnectionGraphSchema = z.object({
    note_path: z.string().min(1).max(1024),
    depth: z.number().int().positive().max(MAX_DEPTH).default(2),
    threshold: z.number().min(0).max(1).default(0.6),
    max_per_level: z.number().int().positive().max(MAX_PER_LEVEL).default(5),
});
const SearchNotesSchema = z.object({
    query: z.string().min(1).max(2000),
    limit: z.number().int().positive().max(MAX_LIMIT).default(10),
    threshold: z.number().min(0).max(1).default(0.5),
    mode: z.enum(['semantic', 'keyword', 'hybrid']).optional(),
    granularity: z.enum(['note', 'block']).default('block'),
    include_excerpt: z.boolean().default(true),
    excerpt_chars: z.number().int().positive().max(MAX_EXCERPT_CHARS_CAP).default(500),
});
const GetEmbeddingNeighborsSchema = z.object({
    embedding_vector: z.array(z.number()).min(1),
    k: z.number().int().positive().max(MAX_LIMIT).default(10),
    threshold: z.number().min(0).max(1).default(0.5),
    granularity: Granularity.default('block'),
    include_excerpt: z.boolean().default(true),
    excerpt_chars: z.number().int().positive().max(MAX_EXCERPT_CHARS_CAP).default(500),
});
const GetNoteContentSchema = z.object({
    note_path: z.string().min(1).max(1024),
    include_blocks: z.array(z.string()).optional(),
    full: z.boolean().default(false),
});
const GetBlockContentSchema = z
    .object({
    block_key: z.string().min(3).max(2048).optional(),
    path: z.string().min(1).max(1024).optional(),
    heading: z.string().min(1).max(1024).optional(),
})
    .refine((v) => !!v.block_key || (!!v.path && !!v.heading), {
    message: 'Provide either block_key or both (path, heading).',
});
const GetStatsSchema = z.object({});
// ---------------------------------------------------------------- tools
const dimsHint = `${activeModel.dims}-dimensional (active model: ${activeModel.model_key})`;
const tools = [
    {
        name: 'get_similar_notes',
        description: 'Find semantically similar items to a given note using embeddings. Results are block-level by default (each hit carries `path`, `heading`, `lines`, optional `excerpt`), so the agent can either use the excerpt or follow the reference via `get_block_content`. Switch `granularity` to "note" for document-level matches.',
        inputSchema: {
            type: 'object',
            properties: {
                note_path: { type: 'string', description: 'Vault-relative path, e.g. "Folder/Note.md".' },
                threshold: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
                limit: { type: 'number', minimum: 1, maximum: MAX_LIMIT, default: 10 },
                granularity: { type: 'string', enum: ['note', 'block'], default: 'block' },
                include_excerpt: { type: 'boolean', default: true },
                excerpt_chars: { type: 'number', minimum: 1, maximum: MAX_EXCERPT_CHARS_CAP, default: 500 },
            },
            required: ['note_path'],
        },
    },
    {
        name: 'search_blocks',
        description: 'Find blocks (heading-scoped sections) similar to an existing block identified by its compound key "path#heading-chain". Returns hits enriched with `path`, `heading`, `lines`, and an `excerpt` for immediate use; follow up with `get_block_content` to fetch the full block text.',
        inputSchema: {
            type: 'object',
            properties: {
                block_key: {
                    type: 'string',
                    description: 'Compound block key, e.g. "Folder/Note.md#Section#Subsection".',
                },
                threshold: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
                limit: { type: 'number', minimum: 1, maximum: MAX_LIMIT, default: 10 },
                include_excerpt: { type: 'boolean', default: true },
                excerpt_chars: { type: 'number', minimum: 1, maximum: MAX_EXCERPT_CHARS_CAP, default: 500 },
            },
            required: ['block_key'],
        },
    },
    {
        name: 'get_connection_graph',
        description: 'Build a nested connection tree starting from a note. Each node has `path`, `similarity`, `depth`, and `children`. A flat `connections` list is also returned for legacy consumers.',
        inputSchema: {
            type: 'object',
            properties: {
                note_path: { type: 'string' },
                depth: { type: 'number', minimum: 1, maximum: MAX_DEPTH, default: 2 },
                threshold: { type: 'number', minimum: 0, maximum: 1, default: 0.6 },
                max_per_level: { type: 'number', minimum: 1, maximum: MAX_PER_LEVEL, default: 5 },
            },
            required: ['note_path'],
        },
    },
    {
        name: 'search_notes',
        description: 'Search by a free-form query. Modes: "semantic" (embed via Ollama, cosine at block granularity by default), "keyword" (substring scoring over note bodies), "hybrid" (RRF fusion of both, k=60). Default is hybrid when Ollama is available, otherwise keyword. Hits carry the same reference packet as `get_similar_notes` (path, heading, lines, excerpt).',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string' },
                mode: { type: 'string', enum: ['semantic', 'keyword', 'hybrid'], description: 'Default: hybrid if semantic is available, else keyword.' },
                granularity: { type: 'string', enum: ['note', 'block'], default: 'block' },
                limit: { type: 'number', minimum: 1, maximum: MAX_LIMIT, default: 10 },
                threshold: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
                include_excerpt: { type: 'boolean', default: true },
                excerpt_chars: { type: 'number', minimum: 1, maximum: MAX_EXCERPT_CHARS_CAP, default: 500 },
            },
            required: ['query'],
        },
    },
    {
        name: 'get_embedding_neighbors',
        description: `Find nearest neighbors for a raw embedding vector. The vector must be ${dimsHint}. Granularity selects note- or block-level hits.`,
        inputSchema: {
            type: 'object',
            properties: {
                embedding_vector: {
                    type: 'array',
                    items: { type: 'number' },
                    description: `Must have exactly ${activeModel.dims} elements.`,
                },
                k: { type: 'number', minimum: 1, maximum: MAX_LIMIT, default: 10 },
                threshold: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
                granularity: { type: 'string', enum: ['note', 'block'], default: 'block' },
                include_excerpt: { type: 'boolean', default: true },
                excerpt_chars: { type: 'number', minimum: 1, maximum: MAX_EXCERPT_CHARS_CAP, default: 500 },
            },
            required: ['embedding_vector'],
        },
    },
    {
        name: 'get_note_content',
        description: `Retrieve a note's markdown. By default the response is capped at ${MAX_NOTE_CONTENT_CHARS} characters; set \`full: true\` to disable the cap.`,
        inputSchema: {
            type: 'object',
            properties: {
                note_path: { type: 'string' },
                include_blocks: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional list of heading chains to extract as named blocks.',
                },
                full: { type: 'boolean', default: false },
            },
            required: ['note_path'],
        },
    },
    {
        name: 'get_block_content',
        description: 'Retrieve the full markdown of a single block identified by its compound key, or by (path, heading) pair. Use this after `get_similar_notes` / `search_blocks` when the excerpt is not enough.',
        inputSchema: {
            type: 'object',
            properties: {
                block_key: { type: 'string', description: 'Compound key "<path>#<heading-chain>".' },
                path: { type: 'string' },
                heading: { type: 'string', description: 'Heading chain, with or without a leading "#".' },
            },
        },
    },
    {
        name: 'get_stats',
        description: 'Diagnostics: active model, runtime-detected dims, totals (notes, blocks), vault name, vault path.',
        inputSchema: { type: 'object', properties: {} },
    },
];
// ---------------------------------------------------------------- server
const server = new Server({ name: 'smart-connections-mcp', version: '2.0.0-alpha' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
    try {
        switch (name) {
            case 'get_similar_notes': {
                const p = GetSimilarNotesSchema.parse(args);
                const results = searchEngine.getSimilarNotes(p.note_path, p.threshold, p.limit, {
                    granularity: p.granularity,
                    include_excerpt: p.include_excerpt,
                    excerpt_chars: p.excerpt_chars,
                });
                return ok({ meta: baseMeta(), results });
            }
            case 'search_blocks': {
                const p = SearchBlocksSchema.parse(args);
                const results = searchEngine.getSimilarBlocks(p.block_key, p.threshold, p.limit, {
                    include_excerpt: p.include_excerpt,
                    excerpt_chars: p.excerpt_chars,
                });
                return ok({ meta: baseMeta(), results });
            }
            case 'get_connection_graph': {
                const p = GetConnectionGraphSchema.parse(args);
                const graph = searchEngine.getConnectionGraph(p.note_path, p.depth, p.threshold, p.max_per_level);
                return ok({ meta: baseMeta(), graph });
            }
            case 'search_notes': {
                const p = SearchNotesSchema.parse(args);
                const out = await searchEngine.searchByQuery(p.query, {
                    mode: p.mode,
                    limit: p.limit,
                    threshold: p.threshold,
                    granularity: p.granularity,
                    include_excerpt: p.include_excerpt,
                    excerpt_chars: p.excerpt_chars,
                });
                return ok({
                    meta: {
                        ...baseMeta(),
                        search_mode: out.mode,
                        fallback_from: out.fallback_from,
                        warnings: out.warnings,
                    },
                    results: out.results,
                });
            }
            case 'get_embedding_neighbors': {
                const p = GetEmbeddingNeighborsSchema.parse(args);
                const results = searchEngine.getEmbeddingNeighbors(p.embedding_vector, p.k, p.threshold, {
                    granularity: p.granularity,
                    include_excerpt: p.include_excerpt,
                    excerpt_chars: p.excerpt_chars,
                });
                return ok({ meta: baseMeta(), results });
            }
            case 'get_note_content': {
                const p = GetNoteContentSchema.parse(args);
                const result = searchEngine.getNoteWithContext(p.note_path, p.include_blocks ?? []);
                const capped = !p.full && result.content.length > MAX_NOTE_CONTENT_CHARS;
                const content = capped ? result.content.slice(0, MAX_NOTE_CONTENT_CHARS) : result.content;
                return ok({
                    meta: { ...baseMeta(), truncated: capped, original_length: result.content.length },
                    path: result.path,
                    content,
                    blocks: result.blocks,
                });
            }
            case 'get_block_content': {
                const p = GetBlockContentSchema.parse(args);
                const result = searchEngine.getBlockContent(p);
                return ok({ meta: baseMeta(), ...result });
            }
            case 'get_stats': {
                GetStatsSchema.parse(args);
                const loadStats = loader.getLoadStats();
                return ok({ meta: baseMeta(), ...searchEngine.getStats(), load: loadStats });
            }
            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            content: [{ type: 'text', text: JSON.stringify({ error: message, meta: baseMeta() }, null, 2) }],
            isError: true,
        };
    }
});
function baseMeta() {
    return {
        vault_name: VAULT_NAME,
        model_key: activeModel.model_key,
        dims: activeModel.dims,
        semantic_available: searchEngine.hasSemantic(),
    };
}
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[smart-connections-mcp] running on stdio');
//# sourceMappingURL=index.js.map