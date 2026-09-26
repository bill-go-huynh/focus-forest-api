import { assertTestDatabaseUrl } from './test-database.js';

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
