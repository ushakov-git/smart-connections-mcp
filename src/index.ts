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
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { loadDotEnv } from './env-loader.js';
import { SmartConnectionsLoader } from './smart-connections-loader.js';
import { SearchEngine } from './search-engine.js';
import { OllamaClient } from './ollama-client.js';
import { VaultWatcher } from './vault-watcher.js';
import { LinkResolver } from './link-resolver.js';

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

const VAULT_NAME =
  process.env.SMART_VAULT_NAME?.trim() ||
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

let ollamaClient: OllamaClient | null = null;
if (semanticDisabled) {
  console.error('[smart-connections-mcp] semantic search disabled (DISABLE_SEMANTIC_SEARCH=1)');
} else if (!ollamaHost) {
  console.error(
    '[smart-connections-mcp] semantic search: no OLLAMA_HOST and no host in embedding_models.ajson — using keyword only.',
  );
} else {
  const probe = new OllamaClient({
    host: ollamaHost,
    model: ollamaModel,
    expectedDims: activeModel.dims,
  });
  const health = await probe.health();
  if (health.reachable && health.modelAvailable && health.dimsMatch) {
    ollamaClient = probe;
    console.error(
      `[smart-connections-mcp] semantic search: Ollama healthy — host="${ollamaHost}" model="${ollamaModel}" dims=${health.observedDims}`,
    );
  } else {
    console.error(
      `[smart-connections-mcp] semantic search: Ollama probe failed — reachable=${health.reachable} ` +
        `modelAvailable=${health.modelAvailable} dimsMatch=${health.dimsMatch} ` +
        `observedDims=${health.observedDims} error=${health.error ?? 'n/a'}`,
    );
  }
}

// -- Hybrid Reciprocal Rank Fusion tuning ----------------------------------
// `k` is a smoothing constant; same value applied to both lists, so it does
// not shift the semantic↔keyword balance — it only flattens the score curve.
// The real lever for balance is the pair of weights: bump semantic_weight
// (e.g. 0.8) when you want embeddings to dominate, or keyword_weight when
// you search mostly for rare names/quotations.
const fusion = {
  k: parseNum(process.env.RRF_K, 60, 1, 1000),
  semantic_weight: parseNum(process.env.RRF_SEMANTIC_WEIGHT, 0.7, 0, 10),
  keyword_weight: parseNum(process.env.RRF_KEYWORD_WEIGHT, 0.3, 0, 10),
};
const searchEngine = new SearchEngine(loader, VAULT_NAME, ollamaClient, fusion);
const linkResolver = new LinkResolver(loader, VAULT_NAME);

console.error(
  `[smart-connections-mcp] fusion: k=${fusion.k} semantic_weight=${fusion.semantic_weight} keyword_weight=${fusion.keyword_weight}`,
);

function parseNum(raw: string | undefined, dflt: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    console.error(
      `[smart-connections-mcp] ignoring invalid env value "${raw}" (expected ${min}..${max}); using default ${dflt}`,
    );
    return dflt;
  }
  return n;
}

console.error(
  `[smart-connections-mcp] ready — vault="${VAULT_NAME}" path="${VAULT_PATH}" ` +
    `model="${activeModel.model_key}" dims=${activeModel.dims} ` +
    `sources=${loader.getSources().size} blocks=${loader.getBlocks().size} ` +
    `semantic=${ollamaClient ? 'on' : 'off'}`,
);

// ---------------------------------------------------------------- limits

const MAX_NOTE_CONTENT_CHARS = 200_000;
const MAX_EXCERPT_CHARS_CAP = 5_000;
const DEFAULT_EXCERPT_CHARS = 1_500;
const MAX_DEPTH = 4;
const MAX_PER_LEVEL = 25;
const MAX_LIMIT = 100;

// ---------------------------------------------------------------- schemas

const Granularity = z.enum(['note', 'block']);
const ExpandMode = z.enum(['never', 'high-similarity', 'always']);
const DedupLevel = z.union([z.literal(2), z.literal(3)]);
const EXPAND_MAX_CHARS_CAP = 20_000;
const DEFAULT_EXPAND_THRESHOLD = 0.8;
const DEFAULT_EXPAND_MAX_CHARS = 5_000;

// Post-processing knobs shared by every search tool that returns ranked hits.
const PostProcessShape = {
  expand_to_section: ExpandMode.default('high-similarity'),
  expand_threshold: z.number().min(0).max(1).default(DEFAULT_EXPAND_THRESHOLD),
  expand_max_chars: z.number().int().positive().max(EXPAND_MAX_CHARS_CAP).default(DEFAULT_EXPAND_MAX_CHARS),
  deduplicate_by_section: z.boolean().default(true),
  dedup_level: DedupLevel.default(2),
} as const;

const GetSimilarNotesSchema = z.object({
  note_path: z.string().min(1).max(1024),
  threshold: z.number().min(0).max(1).default(0.5),
  limit: z.number().int().positive().max(MAX_LIMIT).default(10),
  granularity: Granularity.default('block'),
  include_excerpt: z.boolean().default(true),
  excerpt_chars: z.number().int().positive().max(MAX_EXCERPT_CHARS_CAP).default(DEFAULT_EXCERPT_CHARS),
  ...PostProcessShape,
});

const SearchBlocksSchema = z.object({
  block_key: z.string().min(3).max(2048),
  threshold: z.number().min(0).max(1).default(0.5),
  limit: z.number().int().positive().max(MAX_LIMIT).default(10),
  include_excerpt: z.boolean().default(true),
  excerpt_chars: z.number().int().positive().max(MAX_EXCERPT_CHARS_CAP).default(DEFAULT_EXCERPT_CHARS),
  ...PostProcessShape,
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
  excerpt_chars: z.number().int().positive().max(MAX_EXCERPT_CHARS_CAP).default(DEFAULT_EXCERPT_CHARS),
  ...PostProcessShape,
});

const GetEmbeddingNeighborsSchema = z.object({
  embedding_vector: z.array(z.number()).min(1),
  k: z.number().int().positive().max(MAX_LIMIT).default(10),
  threshold: z.number().min(0).max(1).default(0.5),
  granularity: Granularity.default('block'),
  include_excerpt: z.boolean().default(true),
  excerpt_chars: z.number().int().positive().max(MAX_EXCERPT_CHARS_CAP).default(DEFAULT_EXCERPT_CHARS),
  ...PostProcessShape,
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

const ResolveLinkSchema = z.object({
  link: z.string().min(1).max(2048),
});

const GetStatsSchema = z.object({});

// ---------------------------------------------------------------- tools

const dimsHint = `${activeModel.dims}-dimensional (active model: ${activeModel.model_key})`;

// JSON-schema fragment for the post-processing knobs, mirrored in every
// tool that returns ranked block-level hits. Kept in one place so the
// four tool schemas stay in sync with the Zod-side `PostProcessShape`.
const postProcessJsonSchema = {
  expand_to_section: {
    type: 'string',
    enum: ['never', 'high-similarity', 'always'],
    default: 'high-similarity',
    description:
      'How to enrich block-level hits with parent-section content. "high-similarity" (default) expands a hit when cosine similarity ≥ expand_threshold OR when the heading ends with a "#{N}" fragment suffix. "always" expands every block hit. "never" keeps only the excerpt. Expansion adds `section_content`, `section_heading`, `section_lines`, and a diagnostic `expansion` object to each hit.',
  },
  expand_threshold: {
    type: 'number',
    minimum: 0,
    maximum: 1,
    default: DEFAULT_EXPAND_THRESHOLD,
    description:
      'Minimum cosine similarity that triggers expansion in "high-similarity" mode. Always applied on the cosine scale — in hybrid mode this is the pre-fusion cosine, not the RRF score.',
  },
  expand_max_chars: {
    type: 'number',
    minimum: 1,
    maximum: EXPAND_MAX_CHARS_CAP,
    default: DEFAULT_EXPAND_MAX_CHARS,
    description:
      'Cap on `section_content` size. Longer sections are truncated; the hit\'s `expansion.truncated_to_max_chars` flag reports when that happens.',
  },
  deduplicate_by_section: {
    type: 'boolean',
    default: true,
    description:
      'Group block-level hits that share the same parent section (level configured by dedup_level). The best-similarity hit is kept; dropped siblings are attached as `sibling_matches`. Useful for wider vault coverage: without dedup, top-5 is often 4 slots of the same section.',
  },
  dedup_level: {
    type: 'number',
    enum: [2, 3],
    default: 2,
    description:
      'Heading level used as the dedup key. 2 groups by "##" (default — widest coverage); 3 groups by "###" (finer; dedups only inside the same subsection).',
  },
} as const;

const tools: Tool[] = [
  {
    name: 'get_similar_notes',
    description:
      'Find semantically similar items to a given note using embeddings. Results are block-level by default (each hit carries `path`, `heading`, `lines`, optional `excerpt`). When a hit is high-similarity or its heading ends with a "#{N}" fragment suffix, the server auto-expands it and adds `section_content` (full parent-section markdown) — prefer that over re-calling `get_block_content`. Switch `granularity` to "note" for document-level matches (expansion disabled in that mode).',
    inputSchema: {
      type: 'object',
      properties: {
        note_path: { type: 'string', description: 'Vault-relative path, e.g. "Folder/Note.md".' },
        threshold: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
        limit: { type: 'number', minimum: 1, maximum: MAX_LIMIT, default: 10 },
        granularity: { type: 'string', enum: ['note', 'block'], default: 'block' },
        include_excerpt: { type: 'boolean', default: true },
        excerpt_chars: { type: 'number', minimum: 1, maximum: MAX_EXCERPT_CHARS_CAP, default: DEFAULT_EXCERPT_CHARS },
        ...postProcessJsonSchema,
      },
      required: ['note_path'],
    },
  },
  {
    name: 'search_blocks',
    description:
      'Find blocks (heading-scoped sections) similar to an existing block identified by its compound key "path#heading-chain". Returns hits enriched with `path`, `heading`, `lines`, and an `excerpt`. By default high-similarity hits and fragment-suffix hits ("#{N}") are auto-expanded with `section_content` (full parent-section markdown) — use that before calling `get_block_content` separately.',
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
        excerpt_chars: { type: 'number', minimum: 1, maximum: MAX_EXCERPT_CHARS_CAP, default: DEFAULT_EXCERPT_CHARS },
        ...postProcessJsonSchema,
      },
      required: ['block_key'],
    },
  },
  {
    name: 'get_connection_graph',
    description:
      'Build a nested connection tree starting from a note. Each node has `path`, `similarity`, `depth`, and `children`. A flat `connections` list is also returned for legacy consumers.',
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
    description:
      'Search by a free-form query. Modes: "semantic" (embed via Ollama, cosine at block granularity by default), "keyword" (substring scoring over note bodies), "hybrid" (RRF fusion of both, k=60). Default is hybrid when Ollama is available, otherwise keyword. Hits carry the same reference packet as `get_similar_notes` (path, heading, lines, excerpt).\n\nIMPORTANT: in "hybrid" mode the `similarity` field contains a raw RRF score (typically ~0.01), NOT a cosine. Items are ordered by rank, not by an absolute 0..1 scale — do not compare hybrid similarity to cosine. For cosine-ranked results use `mode: "semantic"` or call `get_similar_notes` on the top hit. The `threshold` parameter is applied to the semantic component pre-fusion; it does not filter the final hybrid ranking.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        mode: { type: 'string', enum: ['semantic', 'keyword', 'hybrid'], description: 'Default: hybrid if semantic is available, else keyword.' },
        granularity: { type: 'string', enum: ['note', 'block'], default: 'block' },
        limit: { type: 'number', minimum: 1, maximum: MAX_LIMIT, default: 10 },
        threshold: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          default: 0.5,
          description:
            'Minimum cosine similarity. Applied directly in "semantic" mode, applied to the semantic component pre-RRF in "hybrid" mode, and ignored in "keyword" mode. It does NOT filter the final RRF score in hybrid.',
        },
        include_excerpt: { type: 'boolean', default: true },
        excerpt_chars: { type: 'number', minimum: 1, maximum: MAX_EXCERPT_CHARS_CAP, default: DEFAULT_EXCERPT_CHARS },
        ...postProcessJsonSchema,
      },
      required: ['query'],
    },
  },
  {
    name: 'get_embedding_neighbors',
    description: `Find nearest neighbors for a raw embedding vector. The vector must be ${dimsHint}. Granularity selects note- or block-level hits. Auto-expansion and dedup apply to block-level results (see expand_to_section and deduplicate_by_section).`,
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
        excerpt_chars: { type: 'number', minimum: 1, maximum: MAX_EXCERPT_CHARS_CAP, default: DEFAULT_EXCERPT_CHARS },
        ...postProcessJsonSchema,
      },
      required: ['embedding_vector'],
    },
  },
  {
    name: 'get_note_content',
    description:
      `Retrieve a note's markdown. By default the response is capped at ${MAX_NOTE_CONTENT_CHARS} characters and the meta reports \`truncated: true\` when that happens; always check that flag. For long notes (content-heavy reference material, curriculum, long-form research) pass \`full: true\` to disable the cap and receive the complete text — there is no security risk beyond what the path-containment guard already blocks.`,
    inputSchema: {
      type: 'object',
      properties: {
        note_path: { type: 'string' },
        include_blocks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of heading chains to extract as named blocks.',
        },
        full: {
          type: 'boolean',
          default: false,
          description: `Disable the ${MAX_NOTE_CONTENT_CHARS}-character cap. Use when the note is known or expected to be long.`,
        },
      },
      required: ['note_path'],
    },
  },
  {
    name: 'get_block_content',
    description:
      'Retrieve the full markdown of a single block identified by its compound key, or by (path, heading) pair. Use this after `get_similar_notes` / `search_blocks` when the excerpt is not enough.',
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
    name: 'resolve_link',
    description:
      'Parse an Obsidian-style link and return the vault-relative `path` plus optional `heading`. Accepts wikilinks like "[[Folder/Note#Section]]" / "[[Note|Alias]]" and obsidian:// URIs (`open?vault=...&file=...`, or advanced-uri `filepath`/`heading`/`block`). Does not read the file — pair with `get_note_content` or `get_block_content` to fetch contents.',
    inputSchema: {
      type: 'object',
      properties: {
        link: { type: 'string', description: 'Wikilink or obsidian:// URI.' },
      },
      required: ['link'],
    },
  },
  {
    name: 'get_stats',
    description:
      'Diagnostics: active model, runtime-detected dims, totals (notes, blocks), vault name, vault path, Ollama availability.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ---------------------------------------------------------------- server

const server = new Server(
  { name: 'smart-connections-mcp', version: '2.0.0-alpha' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const startedAt = Date.now();

  const ok = (data: unknown) => {
    const execution_ms = Date.now() - startedAt;
    // Merge execution_ms into meta if the payload uses the {meta, ...} shape.
    if (data && typeof data === 'object' && 'meta' in (data as Record<string, unknown>)) {
      const d = data as { meta?: Record<string, unknown>; [k: string]: unknown };
      d.meta = { ...(d.meta ?? {}), execution_ms };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  };

  try {
    switch (name) {
      case 'get_similar_notes': {
        const p = GetSimilarNotesSchema.parse(args);
        const results = searchEngine.getSimilarNotes(p.note_path, p.threshold, p.limit, {
          granularity: p.granularity,
          include_excerpt: p.include_excerpt,
          excerpt_chars: p.excerpt_chars,
          expand_to_section: p.expand_to_section,
          expand_threshold: p.expand_threshold,
          expand_max_chars: p.expand_max_chars,
          deduplicate_by_section: p.deduplicate_by_section,
          dedup_level: p.dedup_level,
        });
        return ok({ meta: baseMetaWithPostProcess(results, p), results });
      }

      case 'search_blocks': {
        const p = SearchBlocksSchema.parse(args);
        const results = searchEngine.getSimilarBlocks(p.block_key, p.threshold, p.limit, {
          include_excerpt: p.include_excerpt,
          excerpt_chars: p.excerpt_chars,
          expand_to_section: p.expand_to_section,
          expand_threshold: p.expand_threshold,
          expand_max_chars: p.expand_max_chars,
          deduplicate_by_section: p.deduplicate_by_section,
          dedup_level: p.dedup_level,
        });
        return ok({ meta: baseMetaWithPostProcess(results, p), results });
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
          expand_to_section: p.expand_to_section,
          expand_threshold: p.expand_threshold,
          expand_max_chars: p.expand_max_chars,
          deduplicate_by_section: p.deduplicate_by_section,
          dedup_level: p.dedup_level,
        });
        return ok({
          meta: {
            ...baseMetaWithPostProcess(out.results, p),
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
          expand_to_section: p.expand_to_section,
          expand_threshold: p.expand_threshold,
          expand_max_chars: p.expand_max_chars,
          deduplicate_by_section: p.deduplicate_by_section,
          dedup_level: p.dedup_level,
        });
        return ok({ meta: baseMetaWithPostProcess(results, p), results });
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

      case 'resolve_link': {
        const p = ResolveLinkSchema.parse(args);
        const resolved = linkResolver.resolve(p.link);
        return ok({ meta: { ...baseMeta(), warnings: resolved.warnings }, ...resolved });
      }

      case 'get_stats': {
        GetStatsSchema.parse(args);
        const loadStats = loader.getLoadStats();
        return ok({ meta: baseMeta(), ...searchEngine.getStats(), load: loadStats });
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ error: message, meta: baseMeta() }, null, 2) }],
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
    total_notes: loader.getSources().size,
    total_blocks: loader.getBlocks().size,
    fusion: searchEngine.getFusionConfig(),
  };
}

/**
 * Extend the base meta with per-response diagnostics for the post-processing
 * step. `expansion` reports how many block-level hits were actually enriched
 * with `section_content`; `dedup` reports how many sibling hits were folded.
 * Keeps the `meta` honest about what the returned `results` actually contain,
 * which is useful for an agent that needs to decide when to follow a
 * reference with `get_block_content`.
 */
function baseMetaWithPostProcess(
  results: Array<{ expansion?: { applied: boolean }; sibling_matches?: unknown[] }>,
  params: {
    expand_to_section?: 'never' | 'high-similarity' | 'always';
    expand_threshold?: number;
    expand_max_chars?: number;
    deduplicate_by_section?: boolean;
    dedup_level?: 2 | 3;
    granularity?: 'note' | 'block';
  },
): ReturnType<typeof baseMeta> & {
  expansion?: {
    mode: 'never' | 'high-similarity' | 'always';
    threshold: number;
    max_chars: number;
    applied_count: number;
    skipped_count: number;
  };
  dedup?: {
    enabled: boolean;
    level: 2 | 3;
    groups_collapsed: number;
  };
} {
  const base = baseMeta();
  const granularity = params.granularity ?? 'block';
  const meta: ReturnType<typeof baseMetaWithPostProcess> = base;
  if (granularity !== 'block') return meta;

  const expandMode = params.expand_to_section ?? 'high-similarity';
  if (expandMode !== 'never') {
    let applied = 0;
    let skipped = 0;
    for (const r of results) {
      if (r.expansion?.applied) applied++;
      else if (r.expansion) skipped++;
    }
    meta.expansion = {
      mode: expandMode,
      threshold: params.expand_threshold ?? DEFAULT_EXPAND_THRESHOLD,
      max_chars: params.expand_max_chars ?? DEFAULT_EXPAND_MAX_CHARS,
      applied_count: applied,
      skipped_count: skipped,
    };
  }

  const dedupEnabled = params.deduplicate_by_section ?? true;
  if (dedupEnabled) {
    let collapsed = 0;
    for (const r of results) collapsed += r.sibling_matches?.length ?? 0;
    meta.dedup = {
      enabled: true,
      level: params.dedup_level ?? 2,
      groups_collapsed: collapsed,
    };
  }

  return meta;
}

// ---------------------------------------------------------------- watcher

const watcherEnabled = process.env.DISABLE_WATCHER !== '1';
let watcher: VaultWatcher | null = null;
if (watcherEnabled) {
  watcher = new VaultWatcher(loader, {
    onReload: (file, { updatedSources, updatedBlocks }) => {
      console.error(
        `[watcher] reloaded ${file}: sources+${updatedSources} blocks+${updatedBlocks}` +
          ` (totals sources=${loader.getSources().size} blocks=${loader.getBlocks().size})`,
      );
    },
    onFullReload: () => {
      console.error(
        `[watcher] full reload complete (sources=${loader.getSources().size} blocks=${loader.getBlocks().size})`,
      );
    },
  });
  watcher.start();
} else {
  console.error('[smart-connections-mcp] watcher disabled (DISABLE_WATCHER=1)');
}

// ---------------------------------------------------------------- shutdown

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[smart-connections-mcp] received ${signal} — shutting down`);
  try { watcher?.stop(); } catch { /* ignore */ }
  try { await server.close(); } catch { /* ignore */ }
  // StdioServerTransport closes with the server; nothing else to release.
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// ---------------------------------------------------------------- start

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[smart-connections-mcp] running on stdio');
