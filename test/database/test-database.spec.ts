import { assertTestDatabaseUrl, contentSeedStatements } from './test-database.js';

describe('assertTestDatabaseUrl', () => {
  it('accepts a database whose name ends with _test', () => {
    expect(() =>
      assertTestDatabaseUrl('postgresql://u:p@localhost:5432/focus_forest_test?schema=public'),
    ).not.toThrow();
  });

  it.each([
    'postgresql://u:p@localhost:5432/focus_forest',
    'postgresql://u:p@localhost:5432/focus_forest_testing',
    'postgresql://u:p@localhost:5432/test_focus_forest',
  ])('refuses a non-test database: %s', (url) => {
    expect(() => assertTestDatabaseUrl(url)).toThrow(/test database/i);
  });

  it('refuses a missing or malformed URL', () => {
    expect(() => assertTestDatabaseUrl(undefined)).toThrow();
    expect(() => assertTestDatabaseUrl('not a url')).toThrow();
  });
});

describe('contentSeedStatements', () => {
  it('takes only marked content seeds: the progression catalog, never configuration', () => {
    const statements = contentSeedStatements();
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) expect(statement).toMatch(/^INSERT INTO "/);
    expect(statements.map((s) => /^INSERT INTO "([a-z_]+)"/.exec(s)?.[1])).toEqual([
      'tree_species',
      'badge_definitions',
      'achievement_definitions',
    ]);
    expect(statements.join('\n')).not.toMatch(/product_config/);
  });
});
