/**
 * Watches `.smart-env/multi/` for changes and triggers incremental
 * reloads in the SmartConnectionsLoader. A change in
 * `embedding_models/` or `smart_env.json` forces a full reload, since
 * those affect which model is active and how keys are interpreted.
 *
 * Kept intentionally minimal:
 *   - `fs.watch(..., {recursive: true})` on `multi/` (supported on macOS
 *     and Windows; on Linux we degrade to per-file events — still fine
 *     here because `multi/` is flat).
 *   - Debounce per-file events by `debounceMs` (default 500) to absorb
 *     Smart Connections writing the same file several times in a burst.
 *   - A single `fs.watch` on the smart-env root (non-recursive) for
 *     `smart_env.json` changes.
 *   - No deletion handling: when a `.ajson` file disappears we let the
 *     stale entries age out until the next full reload. Good enough.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SmartConnectionsLoader } from './smart-connections-loader.js';

export interface VaultWatcherOptions {
  debounceMs?: number;
  /** Called after an incremental reload of a single file. */
  onReload?: (file: string, deltas: { updatedSources: number; updatedBlocks: number }) => void;
  /** Called after a full reload (model config changed). */
  onFullReload?: () => void;
  /** Log helper; defaults to console.error. */
  log?: (line: string) => void;
}

export class VaultWatcher {
  private loader: SmartConnectionsLoader;
  private smartEnvPath: string;
  private multiPath: string;
  private embeddingModelsPath: string;
  private opts: Required<Omit<VaultWatcherOptions, 'onReload' | 'onFullReload' | 'log'>> &
    Pick<VaultWatcherOptions, 'onReload' | 'onFullReload' | 'log'>;

  private multiWatcher: fs.FSWatcher | null = null;
  private rootWatcher: fs.FSWatcher | null = null;
  private modelsWatcher: fs.FSWatcher | null = null;
  private pending = new Map<string, NodeJS.Timeout>();
  private fullReloadTimer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(loader: SmartConnectionsLoader, opts: VaultWatcherOptions = {}) {
    this.loader = loader;
    this.smartEnvPath = path.join(loader.getVaultPath(), '.smart-env');
    this.multiPath = path.join(this.smartEnvPath, 'multi');
    this.embeddingModelsPath = path.join(this.smartEnvPath, 'embedding_models');
    this.opts = {
      debounceMs: opts.debounceMs ?? 500,
      onReload: opts.onReload,
      onFullReload: opts.onFullReload,
      log: opts.log,
    };
  }

  start(): void {
    if (this.started) return;
    const log = this.opts.log ?? ((l) => console.error(l));

    if (fs.existsSync(this.multiPath)) {
      try {
        this.multiWatcher = fs.watch(this.multiPath, { recursive: false }, (_event, name) => {
          if (!name || !name.endsWith('.ajson')) return;
          this.debounce(String(name), () => this.incrementalReload(String(name)));
        });
      } catch (err) {
        log(`[watcher] failed to watch ${this.multiPath}: ${stringifyError(err)}`);
      }
    }

    if (fs.existsSync(this.embeddingModelsPath)) {
      try {
        this.modelsWatcher = fs.watch(this.embeddingModelsPath, () => this.scheduleFullReload());
      } catch (err) {
        log(`[watcher] failed to watch ${this.embeddingModelsPath}: ${stringifyError(err)}`);
      }
    }

    if (fs.existsSync(this.smartEnvPath)) {
      try {
        this.rootWatcher = fs.watch(this.smartEnvPath, (_event, name) => {
          if (name === 'smart_env.json') this.scheduleFullReload();
        });
      } catch (err) {
        log(`[watcher] failed to watch ${this.smartEnvPath}: ${stringifyError(err)}`);
      }
    }

    this.started = true;
    log(`[watcher] started — multi=${Boolean(this.multiWatcher)} models=${Boolean(this.modelsWatcher)} root=${Boolean(this.rootWatcher)}`);
  }

  stop(): void {
    if (!this.started) return;
    for (const [, t] of this.pending) clearTimeout(t);
    this.pending.clear();
    if (this.fullReloadTimer) {
      clearTimeout(this.fullReloadTimer);
      this.fullReloadTimer = null;
    }
    this.multiWatcher?.close();
    this.modelsWatcher?.close();
    this.rootWatcher?.close();
    this.multiWatcher = this.modelsWatcher = this.rootWatcher = null;
    this.started = false;
  }

  private debounce(key: string, fn: () => void): void {
    const existing = this.pending.get(key);
    if (existing) clearTimeout(existing);
    this.pending.set(
      key,
      setTimeout(() => {
        this.pending.delete(key);
        try {
          fn();
        } catch (err) {
          (this.opts.log ?? ((l) => console.error(l)))(`[watcher] handler error: ${stringifyError(err)}`);
        }
      }, this.opts.debounceMs),
    );
  }

  private incrementalReload(fileName: string): void {
    const deltas = this.loader.reloadMultiFile(fileName);
    this.opts.onReload?.(fileName, deltas);
  }

  private scheduleFullReload(): void {
    if (this.fullReloadTimer) clearTimeout(this.fullReloadTimer);
    this.fullReloadTimer = setTimeout(() => {
      this.fullReloadTimer = null;
      try {
        this.loader.fullReload();
        this.opts.onFullReload?.();
      } catch (err) {
        (this.opts.log ?? ((l) => console.error(l)))(`[watcher] full reload failed: ${stringifyError(err)}`);
      }
    }, this.opts.debounceMs);
  }
}

function stringifyError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
