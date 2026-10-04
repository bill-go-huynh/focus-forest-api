import type { LocalDate } from '../../src/common/local-date.js';
import type { ConsistencyHarness } from './consistency-harness.js';

/**
 * Test-only month simulation (A3.5, for X3): drives a real app (a ConsistencyHarness with a
 * FixedClock) through whole months with the public API: goals, rest days, sessions submitted
 * at the end of each day, then the clock past the month end and its grace period, so the month
 * closes lazily as it would in production. There is no production "time travel": this file is
 * never imported by src/, and it refuses to run in a production environment.
 */

const MIN = 60_000;

export function assertNotProduction(env: NodeJS.ProcessEnv = process.env): void {
  if (env['NODE_ENV'] === 'production') {
    throw new Error('The month simulation is test tooling and never runs in production.');
  }
}

type User = Awaited<ReturnType<ConsistencyHarness['signUp']>>;

export interface MonthPlan {
  year: number;
  month: number;
  /** Set at the start of the first day, so it applies to the whole month. */
  dailyGoalMinutes?: number;
  restDays?: LocalDate[];
  /** Focus per day: one session per entry, in minutes, in date order. */
  days: { date: LocalDate; sessions: number[] }[];
}

/** Every user is in UTC, so local dates are UTC dates and months end at UTC midnight. */
export class MonthSimulation {
  constructor(private readonly t: ConsistencyHarness) {
    assertNotProduction();
  }

  /** Lives one month through the API: goals and rest days first, then each day's sessions. */
  async live(user: User, plan: MonthPlan): Promise<void> {
    const first = `${plan.year}-${String(plan.month).padStart(2, '0')}-01`;
    // A first daily goal applies from the day it is set.
    await this.t.setNow(`${first}T00:01:00.000Z`);
    if (plan.dailyGoalMinutes !== undefined) {
      await this.t
        .http()
        .put('/me/goals/daily')
        .set(user.auth)
        .send({ minutes: plan.dailyGoalMinutes })
        .expect(200);
    }
    for (const date of plan.restDays ?? []) {
      await this.t.http().put(`/me/rest-days/${date}`).set(user.auth).expect(201);
    }
    for (const { date, sessions } of plan.days) {
      await this.t.setNow(`${date}T22:00:00.000Z`);
      let start = Date.parse(`${date}T06:00:00.000Z`);
      for (const minutes of sessions) {
        await this.t.submit(user, new Date(start).toISOString(), minutes).expect(201);
        start += (minutes + 5) * MIN;
      }
    }
  }

  /** Moves the clock past the month's end and grace period, then opens Home, which closes it. */
  async openNextMonth(user: User, year: number, month: number, graceMinutes = 180) {
    const end = Date.UTC(year, month, 1);
    await this.t.setNow(new Date(end + (graceMinutes + 1) * MIN).toISOString());
    return (await this.t.http().get('/me/home').set(user.auth).expect(200)).body as {
      tree: { year: number; month: number };
      pendingCeremony: { year: number; month: number } | null;
    };
  }
}
