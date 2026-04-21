/**
 * Resolve Obsidian-style links to vault-relative paths.
 *
 * Two input forms are accepted:
 *
 *   1. Wikilink: `[[Folder/Note]]`, `[[Note]]`, `[[Note#Heading]]`,
 *      `[[Note#H1#H2]]`, with optional alias `[[Note|Alias]]`
 *      (alias ignored). Plain note names (without a folder) are
 *      resolved against an index of note basenames; the first match
 *      wins, which mirrors Obsidian's own "shortest path" linking.
 *
 *   2. obsidian:// URI: `obsidian://open?vault=X&file=Note` or
 *      `obsidian://advanced-uri?...&filepath=...&heading=...`. The
 *      `vault` parameter is accepted but not enforced — the caller
 *      runs a single vault per MCP instance, so if `vault` doesn't
 *      match, we still try to resolve `file`/`filepath` inside the
 *      active vault and surface a warning.
 *
 * Returns the vault-relative `path` (with `.md` suffix if missing) and
 * an optional `heading` chain. Never reads the file itself — the caller
 * decides whether to follow up with get_note_content/get_block_content.
 */

import type { SmartConnectionsLoader } from './smart-connections-loader.js';

export interface ResolvedLink {
  input: string;
  form: 'wikilink' | 'obsidian-uri';
  path: string;
  heading?: string;
  vault_mismatch?: boolean;
  warnings: string[];
}

export class LinkResolver {
  private loader: SmartConnectionsLoader;
  private vaultName?: string;
  /** Basename (without extension) → list of full vault-relative paths. */
  private basenameIndex: Map<string, string[]> | null = null;

  constructor(loader: SmartConnectionsLoader, vaultName?: string) {
    this.loader = loader;
    this.vaultName = vaultName;
  }

  resolve(input: string): ResolvedLink {
    const trimmed = input.trim();
    if (trimmed.startsWith('obsidian://')) return this.resolveUri(trimmed);
    return this.resolveWikilink(trimmed);
  }

  // ---------------------------------------------------------- wikilink

  private resolveWikilink(raw: string): ResolvedLink {
    const warnings: string[] = [];
    let body = raw;
    // Strip optional [[ ]] wrapping.
    const m = body.match(/^\[\[(.*)\]\]$/);
    if (m) body = m[1];

    // Split alias off: `Note|Alias` → `Note`.
    const pipeIdx = body.indexOf('|');
    if (pipeIdx >= 0) body = body.slice(0, pipeIdx);

    const hashIdx = body.indexOf('#');
    const rawPath = hashIdx >= 0 ? body.slice(0, hashIdx) : body;
    const heading = hashIdx >= 0 ? body.slice(hashIdx) : undefined;
    const resolvedPath = this.resolveNotePath(rawPath, warnings);
    return {
      input: raw,
      form: 'wikilink',
      path: resolvedPath,
      heading,
      warnings,
    };
  }

  // ---------------------------------------------------------- obsidian uri

  private resolveUri(raw: string): ResolvedLink {
    const warnings: string[] = [];
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { input: raw, form: 'obsidian-uri', path: raw, warnings: ['invalid URL'] };
    }

    const params = url.searchParams;
    const vault = params.get('vault');
    const file = params.get('file') ?? params.get('filepath');
    const heading = params.get('heading');
    const block = params.get('block');

    let mismatch = false;
    if (vault && this.vaultName && decodeURIComponent(vault) !== this.vaultName) {
      mismatch = true;
      warnings.push(
        `obsidian:// URI targets vault "${decodeURIComponent(vault)}", this server serves "${this.vaultName}". Resolution attempted inside the active vault.`,
      );
    }

    if (!file) {
      return { input: raw, form: 'obsidian-uri', path: raw, warnings: [...warnings, 'no file/filepath parameter'] };
    }

    const decoded = decodeURIComponent(file);
    const resolvedPath = this.resolveNotePath(decoded, warnings);

    const headingChain = heading
      ? (heading.startsWith('#') ? decodeURIComponent(heading) : `#${decodeURIComponent(heading)}`)
      : block
      ? `#^${decodeURIComponent(block)}`
      : undefined;

    return {
      input: raw,
      form: 'obsidian-uri',
      path: resolvedPath,
      heading: headingChain,
      vault_mismatch: mismatch || undefined,
      warnings,
    };
  }

  // ---------------------------------------------------------- path lookup

  private resolveNotePath(rawPath: string, warnings: string[]): string {
    const normalized = this.withMdSuffix(rawPath.replace(/^\/+/, ''));
    if (this.loader.getSource(normalized)) return normalized;

    // Basename lookup for bare `Note` links.
    if (!rawPath.includes('/')) {
      const idx = this.getBasenameIndex();
      const basename = stripMdSuffix(rawPath);
      const matches = idx.get(basename) ?? [];
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) {
        warnings.push(
          `ambiguous wikilink "${rawPath}" — ${matches.length} candidates: ${matches.slice(0, 5).join(', ')}${matches.length > 5 ? ', ...' : ''}. Returning the first.`,
        );
        return matches[0];
      }
    }

    warnings.push(`path "${normalized}" is not present in the Smart Connections index — may still exist in the vault.`);
    return normalized;
  }

  private withMdSuffix(p: string): string {
    if (/\.(md|markdown|canvas)$/i.test(p)) return p;
    return `${p}.md`;
  }

  private getBasenameIndex(): Map<string, string[]> {
    if (this.basenameIndex) return this.basenameIndex;
    const idx = new Map<string, string[]>();
    for (const p of this.loader.getSources().keys()) {
      const base = p.split('/').pop() ?? p;
      const noExt = stripMdSuffix(base);
      const list = idx.get(noExt);
      if (list) list.push(p);
      else idx.set(noExt, [p]);
    }
    this.basenameIndex = idx;
    return idx;
  }
}

function stripMdSuffix(p: string): string {
  return p.replace(/\.(md|markdown|canvas)$/i, '');
}
