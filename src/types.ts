/**
 * Type definitions for Smart Connections MCP Server.
 */

export interface SmartSource {
  path: string;
  embeddings: {
    [modelKey: string]: {
      vec: number[];
      last_embed?: {
        hash: string;
        tokens?: number;
      };
    };
  };
  last_read?: {
    hash: string;
    at: number;
  };
  class_name?: string;
  last_import?: {
    mtime: number;
    size: number;
    at: number;
    hash: string;
  };
  /** Map of `#heading` → `[startLine, endLine]` (1-based inclusive). */
  blocks: {
    [heading: string]: [number, number];
  };
}

export interface SmartEnvConfig {
  is_obsidian_vault?: boolean;
  smart_blocks?: {
    embed_blocks?: boolean;
    min_chars?: number;
  };
  smart_sources?: {
    min_chars?: number;
    /** Legacy: older plugin versions stored the active model here. */
    embed_model?: {
      adapter?: string;
      [key: string]: unknown;
    };
    file_exclusions?: string;
    folder_exclusions?: string;
    excluded_headings?: string;
  };
  /** Current plugin versions store the active model reference here. */
  embedding_models?: {
    default_model_key?: string;
  };
  [key: string]: unknown;
}

/**
 * Resolved active embedding model for this vault. Produced by the model
 * resolver — a single source of truth carried through the rest of the code.
 */
export interface ActiveModel {
  /** Key used inside source `embeddings[...]` — e.g. "bge-m3:latest". */
  model_key: string;
  /** Provider id, e.g. "ollama" | "transformers". Empty if unknown. */
  provider_key: string;
  /** Full model registry key, e.g. "ollama#1776670752600". Empty if autodetected. */
  full_key: string;
  /** Runtime-detected dimension, or 0 until first vector is seen. */
  dims: number;
  /** Ollama host, if this model is served via Ollama. */
  host?: string;
  /** Ollama endpoint path, if known. */
  endpoint?: string;
  /** How this model was picked — for diagnostics and meta responses. */
  resolution:
    | 'env-override'
    | 'default-model-key'
    | 'autodetect-sources';
}

/**
 * A block is a (source-file, heading-chain) slice indexed by the Smart
 * Connections plugin with its own embedding. Block keys encode the chain
 * as `<path>#<h1>#<h2>...`. The leading `#` belongs to the heading chain.
 */
export interface SmartBlock {
  /** Full compound key without the `smart_blocks:` prefix. */
  key: string;
  /** Vault-relative path to the containing note. */
  source_path: string;
  /** Heading chain including the leading `#`, e.g. `#Section#Subsection`. */
  heading: string;
  /** 1-based inclusive [startLine, endLine] range inside the source file. */
  lines: [number, number];
  /** Byte size of the block at index time. */
  size?: number;
  embeddings: {
    [modelKey: string]: {
      vec: number[];
      last_embed?: { hash?: string; tokens?: number };
    };
  };
}

/** Reference packet returned to MCP clients for a note/block hit. */
export interface ResultRef {
  /** Vault-relative path of the source note. */
  path: string;
  /** Heading chain for block-level hits; absent for note-level hits. */
  heading?: string;
  /** 1-based [start, end] inclusive range for block-level hits. */
  lines?: [number, number];
  /** Vault label for multi-vault setups (from SMART_VAULT_NAME). */
  vault_name?: string;
}

export interface SimilarNote extends ResultRef {
  similarity: number;
  /** Heading list for a note-level hit (block names available under this note). */
  blocks?: string[];
  /** Leading substring of the referenced block/note content. */
  excerpt?: string;
  /** True if the excerpt was truncated. */
  excerpt_truncated?: boolean;
  matchedContent?: string;
}

export interface ConnectionNode {
  root: string;
  path: string;
  depth: number;
  connections: ConnectionNode[];
  similarity: number;
}

export interface ConnectionGraph {
  root: string;
  connections: Array<{
    path: string;
    depth: number;
    similarity: number;
  }>;
}

export interface NoteContent {
  path: string;
  content: string;
  blocks: string[];
}
