import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Analytics are operational data, never product truth (CR.1; docs/06: Insights, growth, streaks,
 * and rewards are derived from sessions). Only the analytics module itself and the admin read
 * the event table; no product module may touch it.
 */
const SRC = fileURLToPath(new URL('..', import.meta.url));
const ALLOWED = ['analytics', 'admin', 'generated'];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return files(path);
    return entry.endsWith('.ts') && !entry.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('analytics boundary (CR.1)', () => {
  it('lets no product module read or write analytics events', () => {
    const offenders = files(SRC)
      .filter((path) => !ALLOWED.includes(relative(SRC, path).split(sep)[0]!))
      .filter((path) =>
        /analyticsEvent|analytics_events|AnalyticsService/.test(readFileSync(path, 'utf8')),
      )
      .map((path) => relative(SRC, path));
    expect(offenders).toEqual([]);
  });
});
