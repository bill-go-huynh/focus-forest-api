import { createHash } from 'node:crypto';

/**
 * The stable variation seed of one monthly tree (docs/03_TREE_SYSTEM.md §7): an unsigned 32-bit
 * integer derived only from the tree's identity, so it is the same in every process and release.
 * The renderer uses it to vary the tree within authored bounds; the backend sends no positions.
 */
export function variationSeed(tree: { userId: string; year: number; month: number }): number {
  const name = `monthly-tree:${tree.userId}:${String(tree.year).padStart(4, '0')}-${String(tree.month).padStart(2, '0')}`;
  return createHash('sha256').update(name).digest().readUInt32BE(0);
}
