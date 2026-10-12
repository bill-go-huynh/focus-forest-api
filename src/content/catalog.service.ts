import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { AdminAuditService } from '../admin/admin-audit.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  bodyProblems,
  CATALOG_FIELDS,
  CATALOG_KINDS,
  type CatalogKind,
  type CatalogValues,
  rowProblems,
} from './catalog-rules.js';

/**
 * The admin content catalog (A6.4; docs/09 later admin). Badges, achievements, species, and
 * cosmetics are created, edited, activated, and retired here instead of by a release; every
 * write is audited with its reason, in the same transaction.
 *
 * Ownership is permanent, so a definition anyone owns keeps what they earned it under: it is
 * never deleted, never goes back to planned, its achievement's criterion and target stay, and
 * the achievement that unlocks it stays. System content (owned by everyone) keeps its status.
 */

export type CatalogItem = Record<string, string | number | boolean | null>;
export type CatalogDetail = CatalogItem & { usedBy: { type: string; id: string }[] };

type Tx = Prisma.TransactionClient;

const SINGULAR: Record<CatalogKind, string> = {
  badges: 'badge',
  achievements: 'achievement',
  species: 'species',
  cosmetics: 'cosmetic',
};

/** The columns each kind answers with, in order. */
const COLUMNS: Record<CatalogKind, string[]> = {
  badges: [
    'id',
    'category',
    'rarity',
    'source',
    'availability',
    'availableFrom',
    'availableUntil',
    'status',
    'name',
    'description',
    'artworkId',
    'sortOrder',
  ],
  achievements: ['id', 'badgeId', 'criterion', 'target', 'progressVisible'],
  species: [
    'id',
    'baseSpeciesId',
    'rarity',
    'source',
    'achievementId',
    'availability',
    'availableFrom',
    'availableUntil',
    'status',
    'name',
    'description',
    'sortOrder',
  ],
  cosmetics: [
    'id',
    'type',
    'rarity',
    'source',
    'achievementId',
    'availability',
    'availableFrom',
    'availableUntil',
    'status',
    'name',
    'description',
    'artworkId',
    'sortOrder',
  ],
};

const DATES = new Set(['availableFrom', 'availableUntil']);

@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  async list(kindText: string): Promise<{ items: CatalogItem[] }> {
    const kind = kindOf(kindText);
    const rows = await this.rows(this.prisma, kind);
    const owners = await this.owners(kind);
    return {
      items: rows.map((row) => ({
        ...render(kind, row),
        owners: owners.get(String(row['id'])) ?? 0,
      })),
    };
  }

  async detail(kindText: string, id: string): Promise<CatalogDetail> {
    const kind = kindOf(kindText);
    const row = await this.row(this.prisma, kind, id);
    const item: CatalogItem = {
      ...render(kind, row),
      owners: await this.ownerCount(this.prisma, kind, row),
    };
    return { ...item, usedBy: await this.usedBy(kind, id) } as CatalogDetail;
  }

  async create(
    adminId: string,
    kindText: string,
    body: Record<string, unknown>,
  ): Promise<CatalogItem> {
    const kind = kindOf(kindText);
    const { problems, values } = bodyProblems(kind, 'create', body);
    problems.push(...rowProblems(kind, { ...blank(kind), ...values }));
    if (problems.length === 0) problems.push(...(await this.referenceProblems(kind, values, null)));
    if (problems.length > 0) throw invalid(problems);

    const id = String(values['id']);
    await this.prisma.$transaction(async (tx) => {
      if (await this.find(tx, kind, id)) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message: `There is already a ${SINGULAR[kind]} with the id ${id}.`,
          code: 'content_exists',
        });
      }
      await this.delegate(tx, kind).create({ data: toData(values) });
      await this.audit.record(
        {
          adminId,
          action: `content.${SINGULAR[kind]}.create`,
          targetType: SINGULAR[kind],
          targetId: id,
          reason: String(body['reason']).trim(),
          details: 'status' in values ? { status: values['status'] ?? null } : {},
        },
        tx,
      );
    });
    return this.detailWithoutUse(kind, id);
  }

  async update(
    adminId: string,
    kindText: string,
    id: string,
    body: Record<string, unknown>,
  ): Promise<CatalogItem> {
    const kind = kindOf(kindText);
    const { problems, values } = bodyProblems(kind, 'update', body);
    if (problems.length > 0) throw invalid(problems);

    await this.prisma.$transaction(async (tx) => {
      const current = await this.row(tx, kind, id);
      const merged = { ...current, ...values };
      const rowIssues = rowProblems(kind, merged);
      rowIssues.push(...(await this.referenceProblems(kind, values, current)));
      const owners = await this.ownerCount(tx, kind, current);
      if (owners > 0) rowIssues.push(...ownedProblems(kind, current, values));
      if (
        current['source'] === 'system' &&
        'status' in values &&
        values['status'] !== current['status']
      ) {
        rowIssues.push('status of system content stays as it is: everyone owns it.');
      }
      if (rowIssues.length > 0) throw invalid(rowIssues);

      const changed = Object.keys(values)
        .filter((name) => !same(current[name], values[name]))
        .sort();
      if (changed.length === 0) return;
      await this.delegate(tx, kind).update({
        where: { id },
        data: toData(Object.fromEntries(changed.map((name) => [name, values[name] ?? null]))),
      });
      const details: Record<string, string | null> = { fields: changed.join(',') };
      if (changed.includes('status')) {
        details['from'] = String(current['status']);
        details['to'] = String(values['status']);
      }
      await this.audit.record(
        {
          adminId,
          action: `content.${SINGULAR[kind]}.update`,
          targetType: SINGULAR[kind],
          targetId: id,
          reason: String(body['reason']).trim(),
          details,
        },
        tx,
      );
    });
    return this.detailWithoutUse(kind, id);
  }

  /** Deletes an item nobody owns and nothing uses; otherwise it is retired instead. */
  async remove(adminId: string, kindText: string, id: string, reason: unknown): Promise<void> {
    const kind = kindOf(kindText);
    if (typeof reason !== 'string' || reason.trim().length < 3 || reason.trim().length > 500) {
      throw invalid(['reason must say why, in 3 to 500 characters.']);
    }
    const inUse = () =>
      new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'This item is owned or used. Retire it instead.',
        code: 'content_in_use',
      });
    try {
      await this.prisma.$transaction(async (tx) => {
        const row = await this.row(tx, kind, id);
        // Ownership rows hold their definition (RESTRICT), so owned content fails below.
        if (row['source'] === 'system') throw inUse();
        await this.delegate(tx, kind).delete({ where: { id } });
        await this.audit.record(
          {
            adminId,
            action: `content.${SINGULAR[kind]}.delete`,
            targetType: SINGULAR[kind],
            targetId: id,
            reason: reason.trim(),
          },
          tx,
        );
      });
    } catch (error) {
      // A foreign key (an achievement, a reward, a tree) still names it.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
        throw inUse();
      }
      throw error;
    }
  }

  private async detailWithoutUse(kind: CatalogKind, id: string): Promise<CatalogItem> {
    const row = await this.row(this.prisma, kind, id);
    return { ...render(kind, row), owners: await this.ownerCount(this.prisma, kind, row) };
  }

  /** Links to other content: they must exist and fit. */
  private async referenceProblems(
    kind: CatalogKind,
    values: CatalogValues,
    current: CatalogValues | null,
  ): Promise<string[]> {
    const problems: string[] = [];
    if (kind === 'achievements' && current === null) {
      const badgeId = String(values['badgeId']);
      const badge = await this.prisma.badgeDefinition.findUnique({
        where: { id: badgeId },
        include: { achievement: true },
      });
      if (!badge) problems.push(`badgeId: there is no badge ${badgeId}.`);
      else if (badge.source !== 'achievement') {
        problems.push(`badgeId: the badge ${badgeId} is not earned by an achievement.`);
      } else if (badge.achievement) {
        problems.push(`badgeId: the badge ${badgeId} already has an achievement.`);
      }
    }
    const achievementId = values['achievementId'];
    if (typeof achievementId === 'string') {
      const found = await this.prisma.achievementDefinition.findUnique({
        where: { id: achievementId },
      });
      if (!found) problems.push(`achievementId: there is no achievement ${achievementId}.`);
    }
    const baseSpeciesId = values['baseSpeciesId'];
    if (typeof baseSpeciesId === 'string') {
      const found = await this.prisma.treeSpecies.findUnique({ where: { id: baseSpeciesId } });
      if (!found) problems.push(`baseSpeciesId: there is no species ${baseSpeciesId}.`);
    }
    return problems;
  }

  private async usedBy(kind: CatalogKind, id: string): Promise<{ type: string; id: string }[]> {
    const used: { type: string; id: string }[] = [];
    if (kind === 'badges' || kind === 'cosmetics') {
      const key = kind === 'badges' ? 'badgeId' : 'cosmeticId';
      if (kind === 'badges') {
        const achievement = await this.prisma.achievementDefinition.findUnique({
          where: { badgeId: id },
        });
        if (achievement) used.push({ type: 'achievement', id: achievement.id });
      }
      for (const m of await this.prisma.eventMilestone.findMany({ where: { [key]: id } })) {
        used.push({ type: 'event', id: m.eventId });
      }
      for (const m of await this.prisma.communityMilestone.findMany({ where: { [key]: id } })) {
        used.push({ type: 'community', id: m.eventId });
      }
      for (const r of await this.prisma.seasonalReward.findMany({ where: { [key]: id } })) {
        used.push({ type: 'season', id: r.themeId });
      }
    }
    if (kind === 'achievements') {
      for (const s of await this.prisma.treeSpecies.findMany({ where: { achievementId: id } })) {
        used.push({ type: 'species', id: s.id });
      }
      for (const c of await this.prisma.cosmeticDefinition.findMany({
        where: { achievementId: id },
      })) {
        used.push({ type: 'cosmetic', id: c.id });
      }
    }
    if (kind === 'species') {
      for (const s of await this.prisma.treeSpecies.findMany({ where: { baseSpeciesId: id } })) {
        used.push({ type: 'species', id: s.id });
      }
    }
    return used;
  }

  private async owners(kind: CatalogKind): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (kind === 'badges' || kind === 'achievements') {
      const grouped = await this.prisma.userBadge.groupBy({ by: ['badgeId'], _count: true });
      const byBadge = new Map(grouped.map((g) => [g.badgeId, g._count]));
      if (kind === 'badges') return byBadge;
      for (const a of await this.prisma.achievementDefinition.findMany()) {
        counts.set(a.id, byBadge.get(a.badgeId) ?? 0);
      }
    } else if (kind === 'species') {
      for (const g of await this.prisma.userSpecies.groupBy({ by: ['speciesId'], _count: true })) {
        counts.set(g.speciesId, g._count);
      }
    } else {
      for (const g of await this.prisma.userCosmetic.groupBy({
        by: ['cosmeticId'],
        _count: true,
      })) {
        counts.set(g.cosmeticId, g._count);
      }
    }
    return counts;
  }

  private ownerCount(client: Tx, kind: CatalogKind, row: CatalogValues): Promise<number> {
    const id = String(row['id']);
    switch (kind) {
      case 'badges':
        return client.userBadge.count({ where: { badgeId: id } });
      case 'achievements':
        return client.userBadge.count({ where: { badgeId: String(row['badgeId']) } });
      case 'species':
        return client.userSpecies.count({ where: { speciesId: id } });
      case 'cosmetics':
        return client.userCosmetic.count({ where: { cosmeticId: id } });
    }
  }

  private async rows(client: Tx, kind: CatalogKind): Promise<CatalogValues[]> {
    const orderBy =
      kind === 'achievements'
        ? [{ id: 'asc' as const }]
        : [{ sortOrder: 'asc' as const }, { id: 'asc' as const }];
    return (await this.delegate(client, kind).findMany({ orderBy })) as CatalogValues[];
  }

  private async find(client: Tx, kind: CatalogKind, id: string): Promise<CatalogValues | null> {
    return (await this.delegate(client, kind).findUnique({
      where: { id },
    })) as CatalogValues | null;
  }

  private async row(client: Tx, kind: CatalogKind, id: string): Promise<CatalogValues> {
    const row = await this.find(client, kind, id);
    if (!row) {
      throw new NotFoundException({
        statusCode: 404,
        error: 'Not Found',
        message: `There is no ${SINGULAR[kind]} ${id}.`,
        code: 'content_not_found',
      });
    }
    return row;
  }

  /** The Prisma model of a kind, used through its common operations only. */
  private delegate(client: Tx, kind: CatalogKind): CatalogDelegate {
    const models: Record<CatalogKind, unknown> = {
      badges: client.badgeDefinition,
      achievements: client.achievementDefinition,
      species: client.treeSpecies,
      cosmetics: client.cosmeticDefinition,
    };
    return models[kind] as CatalogDelegate;
  }
}

interface CatalogDelegate {
  findMany(args: { orderBy: Partial<Record<'id' | 'sortOrder', 'asc'>>[] }): Promise<unknown[]>;
  findUnique(args: { where: { id: string } }): Promise<unknown>;
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
  delete(args: { where: { id: string } }): Promise<unknown>;
}

/** What owned content keeps: the terms it was earned under, and a status past planning. */
function ownedProblems(kind: CatalogKind, current: CatalogValues, values: CatalogValues): string[] {
  const problems: string[] = [];
  const changes = (name: string) => name in values && !same(current[name], values[name]);
  if (kind === 'achievements' && (changes('criterion') || changes('target'))) {
    problems.push('criterion and target stay as they are: people have earned this badge (owned).');
  }
  if (changes('achievementId')) {
    problems.push('achievementId stays as it is: people own this item (owned).');
  }
  if (changes('status') && values['status'] === 'planned') {
    problems.push('status cannot go back to planned: people own this item (owned).');
  }
  return problems;
}

function kindOf(text: string): CatalogKind {
  const kind = CATALOG_KINDS.find((k) => k === text);
  if (!kind) {
    throw new NotFoundException({
      statusCode: 404,
      error: 'Not Found',
      message: 'There is no such content type.',
      code: 'content_type_not_found',
    });
  }
  return kind;
}

/** A new item's optional fields, before the request's values. */
function blank(kind: CatalogKind): CatalogValues {
  return Object.fromEntries(Object.keys(CATALOG_FIELDS[kind].create).map((name) => [name, null]));
}

function render(kind: CatalogKind, row: CatalogValues): CatalogItem {
  return Object.fromEntries(
    COLUMNS[kind].map((name) => {
      const value = row[name] as unknown;
      return [
        name,
        value instanceof Date ? value.toISOString() : ((value ?? null) as CatalogItem[string]),
      ];
    }),
  );
}

function toData(values: CatalogValues): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      DATES.has(name) && typeof value === 'string' ? new Date(value) : value,
    ]),
  );
}

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date) return typeof b === 'string' && a.getTime() === Date.parse(b);
  return (a ?? null) === (b ?? null);
}

function invalid(problems: string[]): UnprocessableEntityException {
  return new UnprocessableEntityException({
    statusCode: 422,
    error: 'Unprocessable Entity',
    message: problems.join(' '),
    code: 'invalid_content',
    problems,
  });
}
