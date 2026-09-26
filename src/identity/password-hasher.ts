import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
/** OWASP's scrypt recommendation: N = 2^17, r = 8, p = 1. */
const DEFAULT_COST = 2 ** 17;
const MAX_COST = 2 ** 20;

function deriveKey(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, options, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

function scryptOptions(cost: number, blockSize: number, parallelism: number): ScryptOptions {
  return { N: cost, r: blockSize, p: parallelism, maxmem: 256 * cost * blockSize };
}

/** Hashes passwords with scrypt from node:crypto. Format: scrypt$N$r$p$salt$key (base64url). */
export class PasswordHasher {
  readonly cost: number;

  constructor(options: { cost?: number } = {}) {
    this.cost = options.cost ?? DEFAULT_COST;
  }

  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_LENGTH);
    const key = await deriveKey(password, salt, scryptOptions(this.cost, BLOCK_SIZE, PARALLELISM));
    return [
      'scrypt',
      this.cost,
      BLOCK_SIZE,
      PARALLELISM,
      salt.toString('base64url'),
      key.toString('base64url'),
    ].join('$');
  }

  /** Never throws: a malformed stored hash simply doesn't match. */
  async verify(password: string, stored: string): Promise<boolean> {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, cost, blockSize, parallelism] = parts.slice(0, 4).map(Number);
    const salt = Buffer.from(parts[4] ?? '', 'base64url');
    const expected = Buffer.from(parts[5] ?? '', 'base64url');
    if (
      !cost ||
      !blockSize ||
      !parallelism ||
      cost > MAX_COST ||
      !Number.isInteger(Math.log2(cost)) ||
      salt.length === 0 ||
      expected.length !== KEY_LENGTH
    ) {
      return false;
    }

    try {
      const actual = await deriveKey(password, salt, scryptOptions(cost, blockSize, parallelism));
      return timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }
}
