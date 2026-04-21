#!/usr/bin/env node
/**
 * Smoke test for Phase 2.1–2.4 on a real bge-m3 vault.
 *
 * Usage:
 *   TEST_VAULT_PATH="/path/to/vault" node test-bge-m3.mjs
 *
 * Optional:
 *   SMART_EMBED_MODEL_KEY="bge-m3:latest"  — force a model
 *   SMART_VAULT_NAME="Develop"              — override vault label
 */

import { SmartConnectionsLoader } from './dist/smart-connections-loader.js';
import { SearchEngine } from './dist/search-engine.js';

const VAULT = process.env.TEST_VAULT_PATH ?? process.env.SMART_VAULT_PATH;
if (!VAULT) {
  console.error('Set TEST_VAULT_PATH (or SMART_VAULT_PATH) to your vault root.');
  process.exit(2);
}

const ok = (label, cond, detail = '') => {
  const mark = cond ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) process.exitCode = 1;
};

console.log(`\n=== smoke: vault=${VAULT} ===\n`);

const loader = new SmartConnectionsLoader(VAULT);
await loader.initialize();

const active = loader.getActiveModel();
const stats = loader.getLoadStats();

ok('active model resolved', Boolean(active.model_key), `model_key="${active.model_key}" resolution=${active.resolution}`);
ok('dims detected (>0)', active.dims > 0, `dims=${active.dims}`);
ok('sources kept > 0', stats.sourcesKept > 0, JSON.stringify(stats));
ok('sources kept == loaded map size', loader.getSources().size === stats.sourcesKept);

// All kept sources must carry a vector of the expected length.
let badDims = 0;
let samplePath = null;
for (const [p, src] of loader.getSources()) {
  const v = src.embeddings?.[active.model_key]?.vec;
  if (!Array.isArray(v) || v.length !== active.dims) badDims += 1;
  if (!samplePath) samplePath = p;
}
ok('all kept vectors have consistent dims', badDims === 0, `bad=${badDims}`);

// Engine-level checks.
const engine = new SearchEngine(loader);
const engineStats = engine.getStats();
ok('engine.getStats().modelKey matches active', engineStats.modelKey === active.model_key);
ok('engine.getStats().embeddingDimension matches detected dims', engineStats.embeddingDimension === active.dims);

if (samplePath) {
  const similar = engine.getSimilarNotes(samplePath, 0.3, 5);
  ok('getSimilarNotes returns results for a sampled note', similar.length > 0, `top="${similar[0]?.path}" sim=${similar[0]?.similarity?.toFixed(3)}`);
}

// Path-traversal defense.
let traversalBlocked = false;
try {
  loader.readNoteContent('../../../etc/passwd');
} catch (e) {
  traversalBlocked = /escapes vault root|must be vault-relative|Note not found/i.test(String(e.message));
}
ok('readNoteContent blocks ../ traversal', traversalBlocked);

let absBlocked = false;
try {
  loader.readNoteContent('/etc/passwd');
} catch (e) {
  absBlocked = /absolute|escapes/i.test(String(e.message));
}
ok('readNoteContent blocks absolute paths', absBlocked);

console.log('\n=== done ===');
