import {
  CURRENT_CONFIG_VALUES,
  configValues,
  SESSION_CONFIG_VALUES,
} from '../../test/support/product-config-values.js';
import { findConfigProblems } from './config-types.js';
import { productConfigRegistry } from './product-config.registry.js';

const problemsWith = (overrides: Record<string, unknown>) =>
  findConfigProblems(productConfigRegistry, configValues(overrides));

describe('production registry', () => {
  it('defines the Phase 2 session rules and the Phase 3 tree growth and vitality rules', () => {
    expect(Object.keys(productConfigRegistry).sort()).toEqual(
      Object.keys(CURRENT_CONFIG_VALUES).sort(),
    );
  });

  it('accepts the current values', () => {
    expect(findConfigProblems(productConfigRegistry, CURRENT_CONFIG_VALUES)).toEqual([]);
  });

  describe('session rules', () => {
    it('accepts whole minutes of at least 1', () => {
      expect(problemsWith({ 'session.minValidMinutes': 1, 'session.maxPauseMinutes': 1 })).toEqual(
        [],
      );
    });

    describe.each(Object.keys(SESSION_CONFIG_VALUES))('%s', (key) => {
      it.each([0, -5, 2.5, '5', null])('rejects %s', (value) => {
        expect(problemsWith({ [key]: value })).toEqual([
          expect.stringContaining(`"${key}" must be an integer ≥ 1`),
        ]);
      });
    });
  });

  describe('tree growth', () => {
    it.each([
      ['five strictly increasing minutes', [120, 360, 720, 1200, 1800], true],
      ['out of order', [120, 720, 360, 1200, 1800], false],
      ['a repeated threshold', [120, 360, 360, 1200, 1800], false],
      ['too few stages', [120, 360, 720, 1200], false],
      ['too many stages', [120, 360, 720, 1200, 1800, 2400], false],
      ['zero', [0, 360, 720, 1200, 1800], false],
    ])('growth.stageThresholds: %s', (_, value, valid) => {
      expect(problemsWith({ 'growth.stageThresholds': value }).length === 0).toBe(valid);
    });

    it.each([
      [240, true],
      [1, true],
      [0, false],
      [3.5, false],
    ])('growth.dailySoftCap: %s minutes', (value, valid) => {
      expect(problemsWith({ 'growth.dailySoftCap': value }).length === 0).toBe(valid);
    });

    it.each([
      [40, true],
      [0, true],
      [100, true],
      [-1, false],
      [101, false],
      [0.4, false],
    ])('growth.overCapRate: %s percent', (value, valid) => {
      expect(problemsWith({ 'growth.overCapRate': value }).length === 0).toBe(valid);
    });

    it.each([
      [{ floorPercent: 25 }, true],
      [{ floorPercent: 100 }, true],
      [{ floorPercent: 0 }, false],
      [{ floorPercent: 101 }, false],
      [25, false],
    ])('growth.firstMonthProration: %j', (value, valid) => {
      expect(problemsWith({ 'growth.firstMonthProration': value }).length === 0).toBe(valid);
    });

    it.each([
      [{ activeDays: 60, weeklyConsistency: 40 }, true],
      [{ activeDays: 100, weeklyConsistency: 0 }, true],
      [{ activeDays: 60, weeklyConsistency: 50 }, false],
      [{ activeDays: 60 }, false],
    ])('growth.fullnessWeights: %j', (value, valid) => {
      expect(problemsWith({ 'growth.fullnessWeights': value }).length === 0).toBe(valid);
    });

    it.each([
      [{ activeDays: 24, activeDaysPerWeek: 3 }, true],
      [{ activeDays: 31, activeDaysPerWeek: 7 }, true],
      [{ activeDays: 0, activeDaysPerWeek: 3 }, false],
      [{ activeDays: 32, activeDaysPerWeek: 3 }, false],
      [{ activeDays: 24, activeDaysPerWeek: 8 }, false],
    ])('growth.fullnessTargets: %j', (value, valid) => {
      expect(problemsWith({ 'growth.fullnessTargets': value }).length === 0).toBe(valid);
    });

    it.each([
      [[15, 35, 55, 75, 95], true],
      [[50], true],
      [[], false],
      [[35, 15], false],
      [[15, 101], false],
    ])('growth.fullnessLevels: %j percent', (value, valid) => {
      expect(problemsWith({ 'growth.fullnessLevels': value }).length === 0).toBe(valid);
    });

    it.each([
      [{ dailyGoal: 1, weeklyGoal: 2 }, true],
      [{ dailyGoal: 0, weeklyGoal: 2 }, false],
      [{ dailyGoal: 1 }, false],
    ])('growth.blossomPoints: %j', (value, valid) => {
      expect(problemsWith({ 'growth.blossomPoints': value }).length === 0).toBe(valid);
    });

    it.each([
      [[1, 3, 6, 10, 15, 21, 28], true],
      [[], false],
      [[3, 1], false],
      [[0, 3], false],
    ])('growth.blossomThresholds: %j', (value, valid) => {
      expect(problemsWith({ 'growth.blossomThresholds': value }).length === 0).toBe(valid);
    });

    it.each([
      [[180, 360, 600, 900, 1260], true],
      [[180], true],
      [[], false],
      [[180, 180], false],
      [[60, 120, 180, 240, 300, 360, 420, 480, 540, 600, 660], false],
    ])('growth.richnessTiers: %j minutes after Final Form', (value, valid) => {
      expect(problemsWith({ 'growth.richnessTiers': value }).length === 0).toBe(valid);
    });

    it.each([
      [[10, 25, 40], true],
      [[], true],
      [[25, 10], false],
      [[0, 10], false],
    ])('growth.focusHourMilestones: %j hours', (value, valid) => {
      expect(problemsWith({ 'growth.focusHourMilestones': value }).length === 0).toBe(valid);
    });
  });

  describe('vitality', () => {
    it.each([
      [{ thrivingActiveRunDays: 2, healthyWithinDays: 1, stableWithinDays: 2 }, true],
      [{ thrivingActiveRunDays: 1, healthyWithinDays: 2, stableWithinDays: 5 }, true],
      [{ thrivingActiveRunDays: 2, healthyWithinDays: 2, stableWithinDays: 2 }, false],
      [{ thrivingActiveRunDays: 2, healthyWithinDays: 3, stableWithinDays: 2 }, false],
      [{ thrivingActiveRunDays: 0, healthyWithinDays: 1, stableWithinDays: 2 }, false],
      [{ thrivingActiveRunDays: 2, healthyWithinDays: 0, stableWithinDays: 2 }, false],
      [{ healthyWithinDays: 1, stableWithinDays: 2 }, false],
    ])('vitality.rules: %j', (value, valid) => {
      expect(problemsWith({ 'vitality.rules': value }).length === 0).toBe(valid);
    });
  });

  describe('goals, rest days, streaks, and recovery', () => {
    it.each([
      ['goal.dailyDefaultMinutes', 30, true],
      ['goal.dailyDefaultMinutes', 0, false],
      ['restDay.maxPerWeek', 0, true],
      ['restDay.maxPerWeek', 7, true],
      ['restDay.maxPerWeek', 8, false],
      ['restDay.allowSameDay', false, true],
      ['restDay.allowSameDay', 'yes', false],
      ['streak.milestones', [3, 7, 14, 30, 60, 100], true],
      ['streak.milestones', [7, 3], false],
      ['streak.milestones', [0, 3], false],
      ['recovery.mechanics', { nextDaySession: { minPreviousStreak: 3 } }, true],
      ['recovery.mechanics', { nextDaySession: { minPreviousStreak: 0 } }, false],
      ['recovery.mechanics', { token: {} }, false],
      ['recovery.limit', { perMonth: 1 }, true],
      ['recovery.limit', { perMonth: 0 }, true],
      ['recovery.limit', { perMonth: -1 }, false],
      ['vitality.goalConsistency', { windowDays: 4, metDaysRequired: 3 }, true],
      ['vitality.goalConsistency', { windowDays: 4, metDaysRequired: 4 }, true],
      ['vitality.goalConsistency', { windowDays: 4, metDaysRequired: 5 }, false],
      ['vitality.goalConsistency', { windowDays: 0, metDaysRequired: 0 }, false],
    ])('%s: %j', (key, value, valid) => {
      expect(problemsWith({ [key]: value }).length === 0).toBe(valid);
    });
  });
});
