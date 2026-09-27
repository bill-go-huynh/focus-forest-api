import { integer, type ConfigRegistry } from './config-types.js';

export const PRODUCT_CONFIG_REGISTRY = Symbol('PRODUCT_CONFIG_REGISTRY');

/**
 * Every Product configuration key the backend knows (docs/06_DOMAIN_MODEL.md →
 * Product configuration). Keys are added by the phase that introduces them,
 * together with a migration that creates a new configuration version holding
 * their values.
 */
export const productConfigRegistry = {
  // Phase 2: focus sessions.
  'session.minValidMinutes': {
    description: 'Minimum focused time for a session to count, in minutes',
    type: integer({ min: 1 }),
  },
  'session.maxPauseMinutes': {
    description: 'Total pause after which a session ends automatically, in minutes',
    type: integer({ min: 1 }),
  },
} as const satisfies ConfigRegistry;

export type ProductConfigRegistry = typeof productConfigRegistry;
