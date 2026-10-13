import { CURRENT_CONFIG_VALUES } from '../../test/support/product-config-values.js';
import { growthRulesFrom } from '../trees/growth-rules.js';
import { configDiff, previewSamples, SAMPLE_MONTHS } from './config-preview.js';
import type { ProductConfig } from './product-config.js';
import type { ProductConfigRegistry } from './product-config.registry.js';

const configOf = (values: Record<string, unknown>) =>
  ({ get: (key: string) => values[key] }) as unknown as ProductConfig<ProductConfigRegistry>;
const rules = (overrides: Record<string, unknown> = {}) =>
  growthRulesFrom(configOf({ ...CURRENT_CONFIG_VALUES, ...overrides }));

describe('configDiff', () => {
  it('lists the changed keys in order, with both values', () => {
    expect(
      configDiff(
        { 'b.key': 1, 'a.key': [1, 2], same: { x: 1 } },
        { 'b.key': 2, 'a.key': [1, 3], same: { x: 1 } },
      ),
    ).toEqual([
      { key: 'a.key', active: [1, 2], proposed: [1, 3] },
      { key: 'b.key', active: 1, proposed: 2 },
    ]);
  });

  it('shows added and removed keys as null on the missing side', () => {
    expect(configDiff({ old: 1 }, { fresh: 2 })).toEqual([
      { key: 'fresh', active: null, proposed: 2 },
      { key: 'old', active: 1, proposed: null },
    ]);
  });

  it('is empty for equal values, whatever the key order inside objects', () => {
    expect(configDiff({ k: { a: 1, b: 2 } }, { k: { b: 2, a: 1 } })).toEqual([]);
  });
});

describe('previewSamples', () => {
  it('grows the same sample months under both versions', () => {
    const preview = previewSamples(rules(), rules());
    expect(preview.map((sample) => sample.id)).toEqual(SAMPLE_MONTHS.map((sample) => sample.id));
    for (const sample of preview) {
      expect(sample.proposed).toEqual(sample.active);
      expect(sample.label.length).toBeGreaterThan(0);
    }
  });

  it('shows a stricter version growing smaller trees, and a looser one larger', () => {
    const active = rules();
    const stricter = rules({ 'growth.stageThresholds': [600, 1200, 2400, 4800, 9600] });
    const deep = (preview: ReturnType<typeof previewSamples>) =>
      preview.find((sample) => sample.id === 'deep')!;
    const strict = deep(previewSamples(active, stricter));
    expect(strict.active.stage).toBe('final_form');
    expect(strict.proposed.stage).not.toBe('final_form');

    const looser = rules({ 'growth.stageThresholds': [10, 20, 30, 40, 50] });
    const light = previewSamples(active, looser).find((sample) => sample.id === 'light')!;
    expect(light.proposed.stage).toBe('final_form');
    expect(light.active.stage).not.toBe('final_form');
  });

  it('answers each tree’s earned dimensions and its focus', () => {
    const steady = previewSamples(rules(), rules()).find((sample) => sample.id === 'steady')!;
    expect(Object.keys(steady.active).sort()).toEqual([
      'activeDays',
      'blossomLevel',
      'focusedMinutes',
      'fullnessLevel',
      'growthMinutes',
      'richnessTier',
      'stage',
      'traitIds',
    ]);
    expect(steady.active.activeDays).toBe(22);
    expect(steady.active.focusedMinutes).toBe(22 * 30);
  });

  it('includes a partial first month, prorated', () => {
    const first = SAMPLE_MONTHS.find((sample) => sample.id === 'first-month')!;
    expect(first.input.joinedOn > `${first.input.month.year}-03-01`).toBe(true);
  });
});
