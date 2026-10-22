import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { AdminAuditService } from '../admin/admin-audit.service.js';
import { Clock } from '../common/clock.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  type BadgeTerms,
  contentPackProblems,
  type PackTheme,
  themesOverlap,
} from './content-pack.js';
import { liveBodyProblems, lockedProblems, type LiveStatus } from './live-rules.js';

/**
 * Live operations (A6.5; docs/09 later admin: seasonal content). Themes are written here instead
 * of by content packs, under the same checks (`contentPackProblems`, with the badges that exist).
 * What people already took part in stays as it was: once a theme starts, its start, hemisphere,
 * and rewards are locked and its end only moves later. Every write is audited with its reason.
 */

type Tx = Prisma.TransactionClient;
type Body = Record<string, unknown>;

type LoadedTheme = Prisma.SeasonalThemeGetPayload<{ include: { rewards: true } }>;

const SORT_STEP = 10;

@Injectable()
export class LiveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
    private readonly clock: Clock,
  ) {}

  // Themes ------------------------------------------------------------------------------------

  async themes(): Promise<{ items: Body[] }> {
    const now = this.clock.now();
    const themes = await this.prisma.seasonalTheme.findMany({
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      include: { rewards: true },
    });
    return { items: themes.map((theme) => renderTheme(theme, now)) };
  }

  async theme(id: string): Promise<Body> {
    return renderTheme(await this.loadTheme(this.prisma, id), this.clock.now());
  }

  async createTheme(adminId: string, body: Body): Promise<Body> {
    const { problems, values } = liveBodyProblems('create', body);
    if (problems.length > 0) throw invalid(problems);
    const theme = values as unknown as PackTheme & { status: LiveStatus };
    await this.prisma.$transaction(async (tx) => {
      if (await tx.seasonalTheme.findUnique({ where: { id: theme.id } }))
        throw exists('theme', theme.id);
      const issues = await this.themeProblems(
        tx,
        theme,
        theme.status,
        theme.rewards.map((r) => r.badgeId),
        [],
      );
      if (issues.length > 0) throw invalid(issues);
      await tx.seasonalTheme.create({
        data: {
          id: theme.id,
          name: theme.name,
          description: theme.description,
          environmentId: theme.environmentId,
          hemisphere: theme.hemisphere,
          status: theme.status,
          startsAt: new Date(theme.startsAt),
          endsAt: new Date(theme.endsAt),
          rewards: {
            create: theme.rewards.map((reward, i) => ({
              ...reward,
              sortOrder: (i + 1) * SORT_STEP,
            })),
          },
        },
      });
      await this.audit.record(
        {
          adminId,
          action: 'content.theme.create',
          targetType: 'theme',
          targetId: theme.id,
          reason: reasonOf(body),
        },
        tx,
      );
    });
    return this.theme(theme.id);
  }

  async updateTheme(adminId: string, id: string, body: Body): Promise<Body> {
    const { problems, values } = liveBodyProblems('update', body);
    if (problems.length > 0) throw invalid(problems);
    await this.prisma.$transaction(async (tx) => {
      const loaded = await this.loadTheme(tx, id);
      const current = packTheme(loaded);
      const currentValues: Body = { ...current, status: loaded.status };
      const changed = (name: string) =>
        JSON.stringify(currentValues[name]) !== JSON.stringify(values[name]);
      const names = Object.keys(values).filter(changed).sort();
      const started = this.clock.now() >= loaded.startsAt;
      const issues = started ? lockedProblems(current, values, changed) : [];
      const merged = { ...current, ...values };
      const status = (values['status'] ?? loaded.status) as LiveStatus;
      const written = 'rewards' in values ? merged.rewards.map((r) => r.badgeId) : [];
      const kept = 'rewards' in values ? [] : current.rewards.map((r) => r.badgeId);
      issues.push(...(await this.themeProblems(tx, merged, status, written, kept)));
      if (issues.length > 0) throw invalid(issues);
      if (names.length === 0) return;

      const fields = [
        'name',
        'description',
        'environmentId',
        'hemisphere',
        'status',
        'startsAt',
        'endsAt',
      ];
      await tx.seasonalTheme.update({
        where: { id },
        data: Object.fromEntries(
          names
            .filter((name) => fields.includes(name))
            .map((name) => [
              name,
              name.endsWith('At') ? new Date(String(values[name])) : values[name],
            ]),
        ),
      });
      if (names.includes('rewards')) {
        await tx.seasonalReward.deleteMany({ where: { themeId: id } });
        await tx.seasonalReward.createMany({
          data: merged.rewards.map((reward, i) => ({
            themeId: id,
            ...reward,
            sortOrder: (i + 1) * SORT_STEP,
          })),
        });
      }
      await this.audit.record(
        {
          adminId,
          action: 'content.theme.update',
          targetType: 'theme',
          targetId: id,
          reason: reasonOf(body),
          details: { fields: names.join(',') },
        },
        tx,
      );
    });
    return this.theme(id);
  }

  async deleteTheme(adminId: string, id: string, reason: unknown): Promise<void> {
    const why = checkedReason(reason);
    await this.prisma.$transaction(async (tx) => {
      const loaded = await this.loadTheme(tx, id);
      if (this.clock.now() >= loaded.startsAt)
        throw inUse('This theme has started. Retire it instead.');
      await tx.seasonalTheme.delete({ where: { id } });
      await this.audit.record(
        { adminId, action: 'content.theme.delete', targetType: 'theme', targetId: id, reason: why },
        tx,
      );
    });
  }

  /** The content-pack checks, and no overlap with another theme still in use. */
  private async themeProblems(
    tx: Tx,
    theme: PackTheme,
    status: LiveStatus,
    written: string[],
    kept: string[],
  ): Promise<string[]> {
    const issues = contentPackProblems(
      { badges: [], themes: [theme] },
      await this.badgeTerms(tx, written, kept),
    );
    if (status !== 'retired') {
      const others = await tx.seasonalTheme.findMany({
        where: { id: { not: theme.id }, status: { not: 'retired' } },
        include: { rewards: true },
      });
      for (const other of others) {
        if (themesOverlap(theme, packTheme(other)))
          issues.push(`The theme ${theme.id} overlaps ${other.id}.`);
      }
    }
    return issues;
  }

  private async loadTheme(client: Tx, id: string): Promise<LoadedTheme> {
    const theme = await client.seasonalTheme.findUnique({
      where: { id },
      include: { rewards: true },
    });
    if (!theme) throw notFound('theme', id);
    return theme;
  }

  // Leaderboard exclusions ---------------------------------------------------------------------

  async exclusions(): Promise<{ items: Body[] }> {
    const rows = await this.prisma.leaderboardExclusion.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, email: true, username: true, displayName: true } },
        admin: { select: { email: true } },
      },
    });
    return { items: rows.map(renderExclusion) };
  }

  async exclude(adminId: string, body: Body): Promise<Body> {
    const userId = body['userId'];
    const why = checkedReason(body['reason']);
    if (typeof userId !== 'string' || !/^[0-9a-f-]{36}$/i.test(userId)) {
      throw invalid(['userId must be a user id.']);
    }
    const row = await this.prisma.$transaction(async (tx) => {
      if (!(await tx.user.findUnique({ where: { id: userId } }))) throw notFound('user', userId);
      if (await tx.leaderboardExclusion.findUnique({ where: { userId } })) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message: 'This account is already kept off the leaderboards.',
          code: 'already_excluded',
        });
      }
      const created = await tx.leaderboardExclusion.create({
        data: { userId, adminId, reason: why, createdAt: this.clock.now() },
        include: {
          user: { select: { id: true, email: true, username: true, displayName: true } },
          admin: { select: { email: true } },
        },
      });
      await this.audit.record(
        {
          adminId,
          action: 'leaderboard.exclude',
          targetType: 'user',
          targetId: userId,
          reason: why,
        },
        tx,
      );
      return created;
    });
    return renderExclusion(row);
  }

  async include(adminId: string, userId: string, reason: unknown): Promise<void> {
    const why = checkedReason(reason);
    await this.prisma.$transaction(async (tx) => {
      const removed = await tx.leaderboardExclusion.deleteMany({ where: { userId } });
      if (removed.count === 0) throw notFound('exclusion', userId);
      await this.audit.record(
        {
          adminId,
          action: 'leaderboard.include',
          targetType: 'user',
          targetId: userId,
          reason: why,
        },
        tx,
      );
    });
  }

  // Shared ------------------------------------------------------------------------------------

  /**
   * The terms of the rewards a theme names. What this request writes must be a badge
   * (owner decision: badge rewards); what it keeps may also be a cosmetic an older pack chose.
   */
  private async badgeTerms(
    tx: Tx,
    written: string[],
    kept: string[],
  ): Promise<Map<string, BadgeTerms>> {
    const terms = new Map<string, BadgeTerms>();
    const toTerms = (row: {
      source: string;
      availableFrom: Date | null;
      availableUntil: Date | null;
    }) => ({
      source: row.source,
      availableFrom: row.availableFrom?.toISOString() ?? null,
      availableUntil: row.availableUntil?.toISOString() ?? null,
    });
    const ids = [...new Set([...written, ...kept])];
    for (const badge of await tx.badgeDefinition.findMany({ where: { id: { in: ids } } })) {
      terms.set(badge.id, toTerms(badge));
    }
    const keptOnly = kept.filter((id) => !terms.has(id));
    for (const cosmetic of await tx.cosmeticDefinition.findMany({
      where: { id: { in: keptOnly } },
    })) {
      terms.set(cosmetic.id, toTerms(cosmetic));
    }
    return terms;
  }
}

function packTheme(theme: LoadedTheme): PackTheme {
  return {
    id: theme.id,
    name: theme.name,
    description: theme.description,
    environmentId: theme.environmentId,
    hemisphere: theme.hemisphere,
    startsAt: theme.startsAt.toISOString(),
    endsAt: theme.endsAt.toISOString(),
    rewards: theme.rewards
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
      .map((r) => ({
        id: r.id,
        badgeId: (r.badgeId ?? r.cosmeticId)!,
        requiredActiveDays: r.requiredActiveDays,
      })),
  };
}

function renderTheme(theme: LoadedTheme, now: Date): Body {
  const pack = packTheme(theme);
  return { ...pack, status: theme.status, started: now >= theme.startsAt };
}

function renderExclusion(row: {
  user: { id: string; email: string; username: string | null; displayName: string | null };
  admin: { email: string };
  reason: string;
  createdAt: Date;
}): Body {
  return {
    user: row.user,
    reason: row.reason,
    excludedAt: row.createdAt.toISOString(),
    by: row.admin.email,
  };
}

function reasonOf(body: Body): string {
  return String(body['reason']).trim();
}

function checkedReason(reason: unknown): string {
  if (typeof reason !== 'string' || reason.trim().length < 3 || reason.trim().length > 500) {
    throw invalid(['reason must say why, in 3 to 500 characters.']);
  }
  return reason.trim();
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

function exists(kind: string, id: string): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    message: `There is already a ${kind} with the id ${id}.`,
    code: 'content_exists',
  });
}

function inUse(message: string): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    message,
    code: 'content_in_use',
  });
}

function notFound(kind: string, id: string): NotFoundException {
  return new NotFoundException({
    statusCode: 404,
    error: 'Not Found',
    message: `There is no ${kind} ${id}.`,
    code: 'content_not_found',
  });
}
