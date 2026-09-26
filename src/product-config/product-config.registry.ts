import type { ConfigRegistry } from './config-types.js';

export const PRODUCT_CONFIG_REGISTRY = Symbol('PRODUCT_CONFIG_REGISTRY');

/**
 * Every Product configuration key the backend knows (docs/06_DOMAIN_MODEL.md →
 * Product configuration). Keys are added by the phase that introduces them,
 * together with a migration that creates a new configuration version holding
 * their values. No key exists yet: session and growth values are chosen in
 * Phases 2–3.
 */
export const productConfigRegistry = {} as const satisfies ConfigRegistry;

export type ProductConfigRegistry = typeof productConfigRegistry;
