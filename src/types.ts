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

export interface SimilarNote {
  path: string;
  similarity: number;
  blocks?: string[];
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
