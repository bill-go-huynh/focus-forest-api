import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { assertNotProduction } from './month-simulation.js';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'generated' ? [] : sourceFiles(path);
    // Specs are not application code; they may use test helpers.
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('month simulation guard', () => {
  it('refuses to run in production', () => {
    expect(() => assertNotProduction({ NODE_ENV: 'production' })).toThrow(
      /never runs in production/,
    );
    expect(() => assertNotProduction({ NODE_ENV: 'test' })).not.toThrow();
  });

  it('is never reachable from the application source', () => {
    expect(sourceFiles('src').length).toBeGreaterThan(50);
    const offenders = sourceFiles('src').filter((path) => {
      const text = readFileSync(path, 'utf8');
      return /from '[^']*test\//.test(text) || text.includes('month-simulation');
    });
    expect(offenders).toEqual([]);
  });
});
