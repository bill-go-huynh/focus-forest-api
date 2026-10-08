import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ConsistencyHarness } from '../support/consistency-harness.js';
import { normalize } from '../support/contract-normalize.js';
import { get, sid } from '../x3/x3-support.js';

/**
 * X4 contract capture: real answers of every Progression endpoint (A4.1–A4.4) for one scenario,
 * made deterministic and compared with `progression-contract.json`. The mobile repo keeps an
 * identical copy (`src/test-utils/x4/progression-contract.json`) that its zod schemas parse and
 * its screens render. After an intended contract change:
 * `X4_UPDATE_CONTRACT=1 npm run test:int -- test/x4/progression-contract`, then copy the file.
 *
 * The scenario: August history stored as backlog (98 hours, an 8-day streak), so its badges,
 * species, and cosmetic are granted by reconciliation and never reported; October starts as a
 * Seed. The user pins badges, chooses Sakura, equips the garden (and is refused twice), then one
 * session crosses 100 hours and reports exactly what it unlocked; its replay answers the same.
 * The month's species is then locked.
 */

const FILE = fileURLToPath(new URL('./progression-contract.json', import.meta.url));
const t = new ConsistencyHarness('2026-10-01T09:00:00.000Z');

describe('X4 contract capture (HTTP + PostgreSQL)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow('2026-08-01T00:01:00.000Z');
    await t.activateConfig();
  });

  it('answers the Progression endpoints exactly as captured for the mobile client', async () => {
    const user = await t.signUp('progression@example.com', 'UTC', '2026-07-01T00:00:00.000Z');
    // 8 consecutive August days of 735 minutes: 98 hours and an 8-day streak, as backlog.
    await t.focus(
      user,
      [1, 2, 3, 4, 5, 6, 7, 8].map((day) => [`2026-08-0${day}`, 735] as [`${string}`, number]),
    );
    await t.setNow('2026-10-01T09:00:00.000Z');
    const c: Record<string, unknown> = {};
    const http = () => t.http();

    c['achievements'] = await get(t, user, '/me/achievements');
    c['badges'] = await get(t, user, '/me/badges');
    c['speciesOpen'] = await get(t, user, '/me/species');
    c['cosmetics'] = await get(t, user, '/me/cosmetics');
    c['equipmentEmpty'] = await get(t, user, '/me/equipment');
    c['collectionBefore'] = await get(t, user, '/me/collection');

    c['showcase'] = (
      await http()
        .put('/me/badges/showcase')
        .set(user.auth)
        .send({ badgeIds: ['focus-hours:50', 'first-session'] })
        .expect(200)
    ).body;
    c['speciesSelected'] = (
      await http()
        .put('/me/trees/current/species')
        .set(user.auth)
        .send({ speciesId: 'sakura' })
        .expect(200)
    ).body;
    await http()
      .put('/me/equipment/background')
      .set(user.auth)
      .send({ cosmeticId: 'meadow' })
      .expect(200);
    c['equipped'] = (
      await http()
        .put('/me/equipment/decoration')
        .set(user.auth)
        .send({ cosmeticId: 'stone-lantern' })
        .expect(200)
    ).body;
    c['equipNotOwned'] = (
      await http()
        .put('/me/equipment/background')
        .set(user.auth)
        .send({ cosmeticId: 'misty-hills' })
        .expect(422)
    ).body;
    c['equipWrongSlot'] = (
      await http()
        .put('/me/equipment/decoration')
        .set(user.auth)
        .send({ cosmeticId: 'meadow' })
        .expect(422)
    ).body;

    // 130 minutes: 100 hours in total. Only this session's unlocks are reported.
    await t.setNow('2026-10-01T12:00:00.000Z');
    c['sessionUnlock'] = (await t.submit(user, '2026-10-01T09:30:00.000Z', 130, sid(401)))
      .body as unknown;
    c['sessionReplay'] = (await t.submit(user, '2026-10-01T09:30:00.000Z', 130, sid(401)))
      .body as unknown;

    c['speciesLocked'] = await get(t, user, '/me/species');
    c['speciesRefused'] = (
      await http()
        .put('/me/trees/current/species')
        .set(user.auth)
        .send({ speciesId: 'oak' })
        .expect(409)
    ).body;
    c['badgesAfter'] = await get(t, user, '/me/badges');
    c['collectionAfter'] = await get(t, user, '/me/collection');
    c['unequipped'] = (
      await http().delete('/me/equipment/decoration').set(user.auth).expect(200)
    ).body;

    expectParity(c);

    const replace = new Map([
      [user.userId, '00000000-0000-4000-8000-0000000000bb'],
      [user.topicId, '00000000-0000-4000-8000-00000000b001'],
    ]);
    const captured = `${JSON.stringify(normalize(c, replace, new Map()), null, 2)}\n`;
    expect(captured).not.toMatch(/accessToken|refreshToken|password|progression@example\.com/);

    if (process.env['X4_UPDATE_CONTRACT'] === '1' || !existsSync(FILE)) {
      writeFileSync(FILE, captured);
    }
    expect(captured).toBe(readFileSync(FILE, 'utf8'));
  });
});

interface Item {
  id: string;
  kind: string;
  owned: boolean;
  selected?: boolean;
  equipped?: boolean;
  showcasePosition?: number | null;
}
type Body = Record<string, unknown>;
const items = (body: unknown) => (body as { items: { id: string }[] }).items.map((i) => i.id);

/**
 * Parity across endpoints (X4): the Collection Book, derived on its own, agrees with every other
 * progression read and with what the actions reported. Checked on the raw answers.
 */
function expectParity(c: Body): void {
  const sections = (c['collectionAfter'] as { sections: { kind: string; items: Item[] }[] })
    .sections;
  const section = (kind: string) => sections.find((s) => s.kind === kind)!.items;
  const owned = (kind: string) =>
    section(kind)
      .filter((i) => i.owned)
      .map((i) => i.id);

  // Ownership: the collection's owned items are the badges, species, and cosmetics reads.
  expect(owned('badges').sort()).toEqual(items(c['badgesAfter']).sort());
  const ownedSpecies = (c['speciesLocked'] as { items: { id: string }[] }).items.map((s) => s.id);
  expect(owned('species')).toEqual(ownedSpecies);
  const cosmeticsNow = [...items(c['cosmetics']), 'misty-hills'];
  expect(owned('cosmetics').sort()).toEqual(cosmeticsNow.sort());

  // State: the month's species, the equipped garden, the showcase order.
  const current = (c['speciesLocked'] as { current: { speciesId: string; locked: boolean } })
    .current;
  expect(current).toMatchObject({ speciesId: 'sakura', locked: true });
  expect(
    section('species')
      .filter((i) => i.selected)
      .map((i) => i.id),
  ).toEqual(['sakura']);
  expect(
    section('cosmetics')
      .filter((i) => i.equipped)
      .map((i) => i.id)
      .sort(),
  ).toEqual(['meadow', 'stone-lantern']);
  const pinned = (c['badgesAfter'] as { showcase: { id: string }[] }).showcase.map((b) => b.id);
  expect(pinned).toEqual(['focus-hours:50', 'first-session']);
  expect(
    section('badges')
      .filter((i) => i.showcasePosition !== null)
      .sort((a, b) => a.showcasePosition! - b.showcasePosition!)
      .map((i) => i.id),
  ).toEqual(pinned);

  // Reporting: only what the session caused, never the backlog; the replay answers the same.
  const reported = (c['sessionUnlock'] as { progression: Record<string, { id: string }[]> })
    .progression;
  expect({
    badges: reported['newlyEarnedBadges']!.map((b) => b.id),
    species: reported['newlyUnlockedSpecies']!.map((s) => s.id),
    cosmetics: reported['newlyUnlockedCosmetics']!.map((x) => x.id),
  }).toEqual({ badges: ['focus-hours:100'], species: ['fantasy'], cosmetics: ['misty-hills'] });
  expect((c['sessionReplay'] as Body)['progression']).toEqual(reported);
  // The backlog was owned before the session, and was never reported by any action.
  expect(items(c['badges'])).toEqual([
    'first-session',
    'focus-hours:10',
    'focus-hours:50',
    'focus-streak:3',
    'focus-streak:7',
  ]);

  // A species changes presentation only: the session's growth is the same tree state.
  const growth = (c['sessionUnlock'] as { growth: { tree: { species: string } } }).growth;
  expect(growth.tree.species).toBe('sakura');
}
