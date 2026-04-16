/**
 * Indexer module for computing and writing embeddings.
 *
 * Owns the write path: discovers unindexed .md files, computes embeddings
 * via the Embedder, and writes .ajson files compatible with Obsidian's
 * Smart Connections plugin. Produces both file-level (smart_sources) and
 * block-level (smart_blocks) entries.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Config, log } from './security.js';
import { SmartConnectionsData, pathToAjsonFilename } from './data.js';
import { Embedder } from './embeddings.js';

/** Directories to skip during file discovery. */
const EXCLUDED_DIRS = new Set(['.smart-env', '.obsidian', '.git', 'node_modules', '.claude']);

export interface ReindexResult {
  indexed: number;
  skipped: number;
  blocks: number;
  errors: string[];
}

interface Block {
  key: string;           // "path.md#Heading#Subheading"
  content: string;
  lines: [number, number];
}

/**
 * Compute a content hash (djb2 -> base36).
 */
function computeContentHash(content: string): string {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Find .md files that need (re-)indexing: either not indexed yet,
 * or the .md file is newer than its .ajson file.
 */
async function findStaleFiles(
  vaultPath: string,
  smartEnvPath: string,
  pathPrefix?: string
): Promise<string[]> {
  const allFiles = await fs.promises.readdir(vaultPath, { recursive: true });
  const stale: string[] = [];

  for (const file of allFiles) {
    const filePath = String(file);
    if (!filePath.endsWith('.md')) continue;

    const firstDir = filePath.split(path.sep)[0];
    if (EXCLUDED_DIRS.has(firstDir)) continue;

    if (pathPrefix && !filePath.startsWith(pathPrefix)) continue;

    // Compare .md mtime against .ajson mtime
    const ajsonPath = path.join(smartEnvPath, 'multi', pathToAjsonFilename(filePath));
    try {
      const mdStat = fs.statSync(path.join(vaultPath, filePath));
      const ajsonStat = fs.statSync(ajsonPath);
      if (ajsonStat.mtimeMs >= mdStat.mtimeMs) continue; // up to date
    } catch {
      // .ajson doesn't exist — needs indexing
    }

    stale.push(filePath);
  }

  return stale;
}

/**
 * Split markdown content into blocks by headings.
 *
 * Builds hierarchical heading paths like Obsidian: file.md#H1#H2#H3.
 * Skips headings inside fenced code blocks and frontmatter.
 */
function splitIntoBlocks(notePath: string, content: string): Block[] {
  const lines = content.split('\n');
  const blocks: Block[] = [];

  let inFrontmatter = false;
  let inCodeBlock = false;

  // Track heading stack for hierarchical keys
  // Each entry: { level, title }
  const headingStack: Array<{ level: number; title: string }> = [];

  // Track current block start
  let currentBlockStart = -1;
  let currentBlockKey = '';
  let currentBlockContent: string[] = [];

  function flushBlock(endLine: number) {
    if (currentBlockStart >= 0 && currentBlockContent.length > 0) {
      const text = currentBlockContent.join('\n').trim();
      if (text.length >= 50) {
        blocks.push({
          key: currentBlockKey,
          content: text,
          lines: [currentBlockStart + 1, endLine], // 1-indexed
        });
      }
    }
    currentBlockContent = [];
  }

  function buildKey(): string {
    const parts = headingStack.map(h => h.title);
    return `${notePath}#${parts.join('#')}`;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track frontmatter (only at start of file)
    if (i === 0 && line.trim() === '---') {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (line.trim() === '---') {
        inFrontmatter = false;
      }
      continue;
    }

    // Track fenced code blocks
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      currentBlockContent.push(line);
      continue;
    }

    if (inCodeBlock) {
      currentBlockContent.push(line);
      continue;
    }

    // Check for heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      // Flush previous block
      flushBlock(i);

      const level = headingMatch[1].length;
      const title = headingMatch[2].trim();

      // Pop headings at same or deeper level
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop();
      }
      headingStack.push({ level, title });

      currentBlockKey = buildKey();
      currentBlockStart = i;
      currentBlockContent = [line];
    } else {
      currentBlockContent.push(line);
    }
  }

  // Flush last block
  flushBlock(lines.length);

  return blocks;
}

/**
 * Write a single .ajson entry for a note and its blocks.
 */
function writeAjsonEntry(
  smartEnvPath: string,
  notePath: string,
  sourceEmbedding: number[],
  content: string,
  modelKey: string,
  blockEntries: Array<{ block: Block; embedding: number[] }>
): void {
  const hash = computeContentHash(content);
  const now = Date.now();
  const fileName = pathToAjsonFilename(notePath);
  const filePath = path.join(smartEnvPath, 'multi', fileName);

  // Source entry
  const sourceKey = `smart_sources:${notePath}`;
  const sourceEntry = {
    path: notePath,
    embeddings: {
      [modelKey]: {
        vec: sourceEmbedding,
        last_embed: { hash, tokens: content.split(/\s+/).length },
      },
    },
    last_read: { hash, at: now },
    class_name: 'SmartSource',
    last_import: {
      mtime: now,
      size: Buffer.byteLength(content, 'utf-8'),
      at: now,
      hash,
    },
    blocks: {},
    outlinks: [],
    metadata: {},
    task_lines: [],
    tasks: {},
    codeblock_ranges: [],
    last_embed: { hash, at: now },
  };

  let ajsonContent = `\n${JSON.stringify(sourceKey)}: ${JSON.stringify(sourceEntry)},`;

  // Block entries
  for (const { block, embedding } of blockEntries) {
    const blockHash = computeContentHash(block.content);
    const blockKey = `smart_blocks:${block.key}`;
    const blockEntry = {
      key: block.key,
      embeddings: {
        [modelKey]: {
          vec: embedding,
          last_embed: { hash: blockHash, tokens: block.content.split(/\s+/).length },
        },
      },
      lines: block.lines,
      size: Buffer.byteLength(block.content, 'utf-8'),
      class_name: 'SmartBlock',
      last_read: { hash: blockHash, at: now },
      last_embed: { hash: blockHash, at: now },
    };
    ajsonContent += `\n${JSON.stringify(blockKey)}: ${JSON.stringify(blockEntry)},`;
  }

  fs.writeFileSync(filePath, ajsonContent, 'utf-8');
}

/**
 * Embed content with progressive truncation fallback.
 */
async function embedWithFallback(embedder: Embedder, content: string): Promise<number[] | null> {
  for (const limit of [1500, 1000, 600]) {
    try {
      return await embedder.embedContent(content.slice(0, limit));
    } catch {
      // Try shorter
    }
  }
  return null;
}

/**
 * Scan for unindexed .md files and compute embeddings for them.
 */
export async function reindex(
  config: Config,
  data: SmartConnectionsData,
  embedder: Embedder,
  pathPrefix?: string
): Promise<ReindexResult> {
  const smartEnvPath = path.join(config.resolvedVaultPath, '.smart-env');
  const modelKey = data.modelInfo.modelKey;

  const stale = await findStaleFiles(
    config.resolvedVaultPath,
    smartEnvPath,
    pathPrefix
  );

  log('INFO', 'reindex_start', { staleCount: stale.length, pathPrefix });

  const result: ReindexResult = { indexed: 0, skipped: 0, blocks: 0, errors: [] };

  for (let i = 0; i < stale.length; i++) {
    const notePath = stale[i];
    const fullPath = path.join(config.resolvedVaultPath, notePath);

    try {
      const content = fs.readFileSync(fullPath, 'utf-8');

      // Skip files with very little content
      const stripped = content.replace(/^---[\s\S]*?---\s*/, '').trim();
      if (stripped.length < 50) {
        result.skipped++;
        continue;
      }

      // Embed the full file (source-level)
      const sourceEmbedding = await embedWithFallback(embedder, content);
      if (!sourceEmbedding) {
        result.errors.push(`${notePath}: content too long to embed even after truncation`);
        continue;
      }

      // Split into blocks and embed each
      const blocks = splitIntoBlocks(notePath, content);
      const blockEntries: Array<{ block: Block; embedding: number[] }> = [];

      for (const block of blocks) {
        const blockEmbedding = await embedWithFallback(embedder, block.content);
        if (blockEmbedding) {
          blockEntries.push({ block, embedding: blockEmbedding });
        }
      }

      // Remove old entries for this file from in-memory index (headings may have changed)
      for (const key of data.entries.keys()) {
        if (key === notePath || key.startsWith(notePath + '#')) {
          data.entries.delete(key);
        }
      }

      // Write source + blocks to .ajson
      writeAjsonEntry(smartEnvPath, notePath, sourceEmbedding, content, modelKey, blockEntries);

      // Update in-memory index — source entry
      data.entries.set(notePath, {
        path: notePath,
        filePath: notePath,
        embedding: sourceEmbedding,
        type: 'source',
      });

      // Update in-memory index — block entries
      for (const { block, embedding } of blockEntries) {
        data.entries.set(block.key, {
          path: block.key,
          filePath: notePath,
          embedding,
          type: 'block',
        });
      }

      result.indexed++;
      result.blocks += blockEntries.length;

      if ((i + 1) % 10 === 0) {
        log('INFO', 'reindex_progress', {
          filesProcessed: i + 1,
          filesTotal: stale.length,
          blocksTotal: result.blocks,
        });
      }
    } catch (e) {
      const msg = `${notePath}: ${String(e)}`;
      result.errors.push(msg);
      log('WARN', 'reindex_file_error', { notePath, error: String(e) });
    }
  }

  data.lastLoaded = Date.now();

  log('INFO', 'reindex_done', {
    indexed: result.indexed,
    skipped: result.skipped,
    blocks: result.blocks,
    errors: result.errors.length,
  });

  return result;
}
