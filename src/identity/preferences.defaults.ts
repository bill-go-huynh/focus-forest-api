import type { Theme } from '../generated/prisma/client.js';

/**
 * Defaults for a user who has not changed anything. The only place they are defined.
 * - theme: follows the system setting (docs/01_DESIGN_SYSTEM.md §10)
 * - sound: on, so completion is noticeable face-down (docs/02_UX_PRINCIPLES.md → Timer)
 * - reducedMotion: off in-app; the system setting is still respected (docs/11_ACCESSIBILITY.md)
 * - shareUsageData: on for the Core Loop Checkpoint (CR.1, user decision 2026-10-08), with a
 *   toggle and a disclosure in Settings; revisit before a public beta (consent)
 * - notifications: every category off until the user opts in, with no reminder time
 *   (docs/11_ACCESSIBILITY.md → Notification control)
 */
export const DEFAULT_DISPLAY_PREFERENCES: {
  theme: Theme;
  sound: boolean;
  reducedMotion: boolean;
  shareUsageData: boolean;
} = {
  theme: 'system',
  sound: true,
  reducedMotion: false,
  shareUsageData: true,
};

export const DEFAULT_NOTIFICATION_ENABLED = false;
export const DEFAULT_REMINDER_TIME = null;
