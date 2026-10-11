import { isKnownLink, notificationLinks } from './notification-links.js';

describe('notification links (docs/05 §4: a top-level screen with a back path)', () => {
  it('points at the app’s screens', () => {
    expect(notificationLinks.home()).toBe('/');
    expect(notificationLinks.recap(2026, 10)).toBe('/recap/2026/10');
    expect(notificationLinks.room('0190a1b2-0000-7000-8000-000000000001')).toBe(
      '/together/room/0190a1b2-0000-7000-8000-000000000001',
    );
    expect(notificationLinks.event('autumn-study-2026')).toBe('/together/events/autumn-study-2026');
    expect(notificationLinks.challenge('0190a1b2-0000-7000-8000-000000000002')).toBe(
      '/together/challenges/0190a1b2-0000-7000-8000-000000000002',
    );
    expect(notificationLinks.achievements()).toBe('/profile/achievements');
  });

  it('knows every link it builds, and nothing else', () => {
    for (const link of [
      notificationLinks.home(),
      notificationLinks.recap(2027, 1),
      notificationLinks.room('0190a1b2-0000-7000-8000-000000000001'),
      notificationLinks.event('new-year-2027'),
      notificationLinks.challenge('0190a1b2-0000-7000-8000-000000000002'),
      notificationLinks.achievements(),
    ]) {
      expect(isKnownLink(link)).toBe(true);
    }
    for (const link of [
      '',
      'https://example.com',
      '/together/room/../admin',
      '/recap/2026/13',
      '/focus',
      '/together/events/Autumn Study',
      '//evil.example',
    ]) {
      expect(isKnownLink(link)).toBe(false);
    }
  });
});
