import type { PrismaClient } from '../generated/prisma/client.js';
import { type ContentPack, contentPackProblems } from './content-pack.js';

export interface ContentPackResult {
  /** What this run added: badges by count, themes by id. */
  added: { badges: number; themes: string[] };
  /** What was already there and stays as it is. */
  kept: { badges: number; themes: string[] };
}

const SORT_STEP = 10;

/**
 * Adds the pack's missing content in one transaction. A badge or a theme (with its rewards) that
 * already exists is kept as it is, whatever the pack says: content the owner edited since stays edited, and a rerun
 * changes nothing. A pack with problems is refused before anything is written.
 */
export async function applyContentPack(
  prisma: PrismaClient,
  pack: ContentPack,
): Promise<ContentPackResult> {
  const problems = contentPackProblems(pack);
  if (problems.length > 0) {
    throw new Error(`The content pack has problems:\n- ${problems.join('\n- ')}`);
  }

  return prisma.$transaction(async (tx) => {
    const existingBadges = new Set(
      (
        await tx.badgeDefinition.findMany({
          where: { id: { in: pack.badges.map((badge) => badge.id) } },
          select: { id: true },
        })
      ).map((badge) => badge.id),
    );
    const newBadges = pack.badges.filter((badge) => !existingBadges.has(badge.id));
    await tx.badgeDefinition.createMany({
      data: newBadges.map((badge) => ({
        id: badge.id,
        category: 'event' as const,
        rarity: badge.rarity,
        source: badge.source,
        availability: 'limited' as const,
        status: 'active' as const,
        availableFrom: new Date(badge.availableFrom),
        availableUntil: new Date(badge.availableUntil),
        name: badge.name,
        description: badge.description,
        artworkId: badge.id.replace(':', '-'),
      })),
    });

    const existingThemes = new Set(
      (
        await tx.seasonalTheme.findMany({
          where: { id: { in: pack.themes.map((theme) => theme.id) } },
          select: { id: true },
        })
      ).map((theme) => theme.id),
    );
    const newThemes = pack.themes.filter((theme) => !existingThemes.has(theme.id));
    for (const theme of newThemes) {
      await tx.seasonalTheme.create({
        data: {
          id: theme.id,
          name: theme.name,
          description: theme.description,
          environmentId: theme.environmentId,
          hemisphere: theme.hemisphere,
          status: 'active',
          startsAt: new Date(theme.startsAt),
          endsAt: new Date(theme.endsAt),
          sortOrder: (pack.themes.indexOf(theme) + 1) * SORT_STEP,
          rewards: {
            create: theme.rewards.map((reward, i) => ({
              ...reward,
              sortOrder: (i + 1) * SORT_STEP,
            })),
          },
        },
      });
    }

    const ids = (list: { id: string }[]) => list.map((item) => item.id);
    return {
      added: { badges: newBadges.length, themes: ids(newThemes) },
      kept: {
        badges: pack.badges.length - newBadges.length,
        themes: ids(pack.themes.filter((theme) => existingThemes.has(theme.id))),
      },
    };
  });
}
