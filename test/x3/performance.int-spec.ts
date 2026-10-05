import type { LocalDate } from '../../src/common/local-date.js';
import { addDays } from '../../src/common/local-date.js';
import { ConsistencyHarness } from '../support/consistency-harness.js';
import type { X3User } from './x3-support.js';

/**
 * X3 performance characterization (not a release target): SQL statements per request and
 * month-closure runtime, for a user with one month of history and one with 37 months. The
 * numbers are printed for the X3 report; the assertions only pin what must not grow with
 * history (statements per request), so a regression to per-month or per-day queries fails.
 */

const t = new ConsistencyHarness('2026-10-20T12:00:00.000Z', { countQueries: true });

const ENDPOINTS = [
  '/me/home',
  '/me/trees/current',
  '/me/forest',
  '/me/forest?limit=60',
  '/me/insights/week',
  '/me/insights/month',
  '/me/insights/heatmap',
  '/me/insights/records',
  '/me/profile/stats',
  '/me/streak',
  '/me/goals',
  '/me/sessions?limit=50',
  '/me/trees/2026/9',
  '/me/trees/2026/9/recap',
] as const;

/** Focus on five days of every week (two sessions a day), from `from` to 2026-10-19. */
function history(from: LocalDate): [LocalDate, number][] {
  const sessions: [LocalDate, number][] = [];
  for (let date = from; date <= '2026-10-19'; date = addDays(date, 1)) {
    const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) sessions.push([date, 40], [date, 35]);
  }
  return sessions;
}

describe('X3 performance characterization (HTTP + PostgreSQL)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow('2026-10-20T12:00:00.000Z');
    await t.activateConfig();
  });

  async function measure(user: X3User) {
    // The first request closes every ended month.
    const started = performance.now();
    const closureStatements = await t.queries.during(() =>
      t.http().get('/me/home').set(user.auth).expect(200),
    );
    const closureMs = performance.now() - started;
    const statements: Record<string, number> = {};
    const ms: Record<string, number> = {};
    for (const path of ENDPOINTS) {
      const start = performance.now();
      statements[path] = await t.queries.during(() =>
        t.http().get(path).set(user.auth).expect(200),
      );
      ms[path] = performance.now() - start;
    }
    return { closureStatements, closureMs, statements, ms };
  }

  it('keeps statements per request flat from one month to 37 months of history', async () => {
    const small = await t.signUp('small@example.com', 'UTC', '2026-09-01T00:00:00.000Z');
    // The harness inserts with `focus` row by row, with the same shape the server stores.
    await t.focus(small, history('2026-09-01'));
    const large = await t.signUp('large@example.com', 'UTC', '2023-09-01T00:00:00.000Z');
    await t.focus(large, history('2023-09-01'));
    const sessionsLarge = await t.prisma.focusSession.count({ where: { userId: large.userId } });

    const a = await measure(small);
    const b = await measure(large);
    const months = await t.prisma.monthlyTree.count({
      where: { userId: large.userId, status: 'archived' },
    });

    console.info(
      [
        `X3 performance — small: 2 months (1 to close); large: ${sessionsLarge} sessions, ${months} months closed in the first request`,
        `month closure (first Home): small ${a.closureStatements} statements / ${a.closureMs.toFixed(0)} ms; large ${b.closureStatements} statements / ${b.closureMs.toFixed(0)} ms`,
        ...ENDPOINTS.map(
          (path) =>
            `${path.padEnd(28)} statements small ${a.statements[path]} large ${b.statements[path]}; ms small ${a.ms[path]!.toFixed(0)} large ${b.ms[path]!.toFixed(0)}`,
        ),
      ].join('\n'),
    );

    expect(months).toBe(37);
    // Everything after closure: the same number of statements for 1 or 37 months of history.
    for (const path of ENDPOINTS) expect(b.statements[path]).toBe(a.statements[path]);
  }, 300_000);
});
