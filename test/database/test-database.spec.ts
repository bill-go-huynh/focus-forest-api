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
    // Content definitions only: inserted, or (A5.4) a planned badge made active.
    const statement = /^(INSERT INTO|UPDATE) "([a-z_]+)"/;
    for (const sql of statements) expect(sql).toMatch(statement);
    expect(statements.map((s) => statement.exec(s)?.slice(1).join(' '))).toEqual([
      'INSERT INTO tree_species',
      'INSERT INTO badge_definitions',
      'INSERT INTO achievement_definitions',
      // A4.3: the species (bases, then variants) and the cosmetic catalog.
      'INSERT INTO tree_species',
      'INSERT INTO tree_species',
      'INSERT INTO cosmetic_definitions',
      // A5.4: the Focus Together badges become earnable.
      'UPDATE badge_definitions',
      'INSERT INTO achievement_definitions',
    ]);
    expect(statements.join('\n')).not.toMatch(/product_config/);
  });
});
