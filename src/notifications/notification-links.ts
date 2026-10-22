/**
 * Where a notification opens the app (docs/05 §4): a top-level screen with a back path, as an
 * Expo Router path. The app checks a link against the same shapes before following it.
 */

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export const notificationLinks = {
  home: () => '/',
  recap: (year: number, month: number) => `/recap/${year}/${month}`,
  room: (roomId: string) => `/together/room/${roomId}`,
  challenge: (challengeId: string) => `/together/challenges/${challengeId}`,
  achievements: () => '/profile/achievements',
};

const KNOWN = [
  /^\/$/,
  /^\/recap\/\d{4}\/(?:[1-9]|1[0-2])$/,
  new RegExp(`^/together/room/${UUID}$`),
  new RegExp(`^/together/challenges/${UUID}$`),
  /^\/profile\/achievements$/,
];

export function isKnownLink(link: string): boolean {
  return KNOWN.some((pattern) => pattern.test(link));
}
