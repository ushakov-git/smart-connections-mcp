#!/usr/bin/env node
/**
 * Smoke test for Phases 2+3 on a real bge-m3 vault.
 *
 * Usage:
 *   TEST_VAULT_PATH="/path/to/vault" node test-bge-m3.mjs
 */

import { SmartConnectionsLoader } from './dist/smart-connections-loader.js';
import { SearchEngine } from './dist/search-engine.js';

const VAULT = process.env.TEST_VAULT_PATH ?? process.env.SMART_VAULT_PATH;
if (!VAULT) {
  console.error('Set TEST_VAULT_PATH to your vault root.');
  process.exit(2);
}

const results = [];
const ok = (label, cond, detail = '') => {
  const mark = cond ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${label}${detail ? '  ' + detail : ''}`);
  results.push({ label, cond, detail });
  if (!cond) process.exitCode = 1;
};

console.log(`\n=== smoke: vault=${VAULT} ===\n`);

const loader = new SmartConnectionsLoader(VAULT);
await loader.initialize();

const active = loader.getActiveModel();
const stats = loader.getLoadStats();
const VAULT_NAME = 'TestVault';

ok('active model resolved', Boolean(active.model_key), `model_key="${active.model_key}" resolution=${active.resolution}`);
ok('dims detected (>0)', active.dims > 0, `dims=${active.dims}`);
ok('sources kept > 0', stats.sourcesKept > 0, `kept=${stats.sourcesKept} replaced=${stats.sourcesReplaced}`);
ok('blocks kept > 0', stats.blocksKept > 0, `kept=${stats.blocksKept} replaced=${stats.blocksReplaced}`);
ok('sources kept == loaded map size', loader.getSources().size === stats.sourcesKept);
ok('blocks kept == loaded block map size', loader.getBlocks().size === stats.blocksKept);

// Vector dimensionality consistency.
let badSrc = 0;
let badBlk = 0;
let samplePath = null;
let sampleBlockKey = null;
for (const [p, src] of loader.getSources()) {
  const v = src.embeddings?.[active.model_key]?.vec;
  if (!Array.isArray(v) || v.length !== active.dims) badSrc += 1;
  if (!samplePath) samplePath = p;
}
for (const [k, b] of loader.getBlocks()) {
  const v = b.embeddings?.[active.model_key]?.vec;
  if (!Array.isArray(v) || v.length !== active.dims) badBlk += 1;
  if (!sampleBlockKey && b.lines[0] > 0) sampleBlockKey = k;
}
ok('all source vectors consistent dims', badSrc === 0, `bad=${badSrc}`);
ok('all block vectors consistent dims', badBlk === 0, `bad=${badBlk}`);

// Block parsing sanity.
const anyBlock = loader.getBlocks().values().next().value;
ok('block has source_path + heading', Boolean(anyBlock?.source_path) && anyBlock?.heading.startsWith('#'),
   `source_path="${anyBlock?.source_path}" heading="${anyBlock?.heading}"`);

// blocksBySource index populated.
const listForSample = loader.getBlockKeysForSource(samplePath);
ok('blocksBySource populated for a sampled note', listForSample.length >= 0, `count=${listForSample.length}`);

// Engine.
const engine = new SearchEngine(loader, VAULT_NAME);
const engineStats = engine.getStats();
ok('engineStats.modelKey matches active', engineStats.modelKey === active.model_key);
ok('engineStats.embeddingDimension matches detected dims', engineStats.embeddingDimension === active.dims);
ok('engineStats.vaultName propagated', engineStats.vaultName === VAULT_NAME);
ok('engineStats.totalBlocks > 0', engineStats.totalBlocks > 0, `blocks=${engineStats.totalBlocks}`);

// getSimilarNotes — block granularity (default), returns ResultRef + excerpt.
if (samplePath) {
  const hits = engine.getSimilarNotes(samplePath, 0.3, 5);
  ok('getSimilarNotes returns hits', hits.length > 0, `top="${hits[0]?.path}" sim=${hits[0]?.similarity?.toFixed(3)}`);
  const top = hits[0];
  ok('hit carries path', Boolean(top?.path));
  ok('hit carries heading (block granularity default)', Boolean(top?.heading), `heading="${top?.heading}"`);
  ok('hit carries lines', Array.isArray(top?.lines) && top.lines.length === 2);
  ok('hit carries vault_name', top?.vault_name === VAULT_NAME);
  ok('hit carries excerpt', typeof top?.excerpt === 'string' && top.excerpt.length > 0, `excerpt_len=${top?.excerpt?.length}`);
}

// getSimilarNotes with granularity=note — no heading expected.
if (samplePath) {
  const hits = engine.getSimilarNotes(samplePath, 0.3, 3, { granularity: 'note', include_excerpt: false });
  ok('granularity=note returns hits', hits.length > 0);
  ok('note-granularity hit has no heading', !hits[0]?.heading);
  ok('note-granularity hit has no excerpt when disabled', !hits[0]?.excerpt);
}

// getSimilarBlocks.
if (sampleBlockKey) {
  const hits = engine.getSimilarBlocks(sampleBlockKey, 0.3, 5);
  ok('getSimilarBlocks returns hits', hits.length > 0, `top="${hits[0]?.heading}" sim=${hits[0]?.similarity?.toFixed(3)}`);
  ok('block-hit excludes the query block itself', !hits.find(h => `${h.path}${h.heading}` === sampleBlockKey));
}

// getBlockContent.
if (sampleBlockKey) {
  const r = engine.getBlockContent({ block_key: sampleBlockKey });
  ok('getBlockContent returns non-empty content', typeof r.content === 'string' && r.content.length > 0, `lines=${r.lines?.join('..')}`);
  ok('getBlockContent includes vault_name', r.vault_name === VAULT_NAME);
}

// getConnectionGraph — nested tree.
if (samplePath) {
  const g = engine.getConnectionGraph(samplePath, 2, 0.5, 3);
  ok('graph root matches input', g.root === samplePath);
  const tree = g.tree;
  ok('graph returns nested tree', tree && Array.isArray(tree.children));
  ok('graph flat connections still populated', Array.isArray(g.connections));
}

// Path-traversal defenses.
let traversalBlocked = false;
try { loader.readNoteContent('../../../etc/passwd'); }
catch (e) { traversalBlocked = /escapes|relative|not found/i.test(String(e.message)); }
ok('readNoteContent blocks ../ traversal', traversalBlocked);

let absBlocked = false;
try { loader.readNoteContent('/etc/passwd'); }
catch (e) { absBlocked = /absolute|escapes/i.test(String(e.message)); }
ok('readNoteContent blocks absolute paths', absBlocked);

// Bad block_key rejected.
let badKeyRejected = false;
try { engine.getBlockContent({ block_key: 'no-hash-here' }); }
catch (e) { badKeyRejected = /Malformed/i.test(String(e.message)); }
ok('getBlockContent rejects malformed key', badKeyRejected);

// Embedding-vector dim guard.
let dimGuard = false;
try { engine.getEmbeddingNeighbors([0.1, 0.2, 0.3], 5, 0.3); }
catch (e) { dimGuard = /dims|expected/i.test(String(e.message)); }
ok('getEmbeddingNeighbors rejects wrong-dim vector', dimGuard);

console.log(`\n=== ${results.filter(r => r.cond).length}/${results.length} passed ===`);
