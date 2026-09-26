import { boolean, integer, list, type ConfigRegistry } from './config-types.js';
import {
  ConfigVersionNotFoundError,
  InvalidConfigValueError,
  InvalidConfigVersionError,
  MissingConfigValueError,
  NoActiveConfigVersionError,
  UnknownConfigKeyError,
} from './product-config.errors.js';
import type { ProductConfigRepository, StoredConfigVersion } from './product-config.repository.js';
import { ProductConfigService } from './product-config.service.js';

// A registry used only by these tests. The production registry grows phase by phase.
const testRegistry = {
  'test.minutes': { description: 'A number of minutes', type: integer({ min: 1 }) },
  'test.enabled': { description: 'A switch', type: boolean() },
  'test.milestones': { description: 'Milestone days', type: list(integer({ min: 1 })) },
} satisfies ConfigRegistry;

const validValues = { 'test.minutes': 5, 'test.enabled': true, 'test.milestones': [3, 7] };

class InMemoryRepository implements Pick<
  ProductConfigRepository,
  'findVersion' | 'findActiveVersion' | 'createVersion' | 'setActiveVersion'
> {
  private readonly versions: StoredConfigVersion[] = [];
  private active: number | null = null;

  findVersion(version: number): Promise<StoredConfigVersion | null> {
    return Promise.resolve(this.versions.find((v) => v.version === version) ?? null);
  }

  findActiveVersion(): Promise<StoredConfigVersion | null> {
    return this.active === null ? Promise.resolve(null) : this.findVersion(this.active);
  }

  createVersion(values: Record<string, unknown>, note: string): Promise<StoredConfigVersion> {
    const stored = { version: this.versions.length + 1, values, note, createdAt: new Date(0) };
    this.versions.push(stored);
    return Promise.resolve(stored);
  }

  setActiveVersion(version: number): Promise<void> {
    this.active = version;
    return Promise.resolve();
  }

  /** Stores raw values without validation, like data written by an older release. */
  insertRaw(values: Record<string, unknown>): number {
    this.versions.push({
      version: this.versions.length + 1,
      values,
      note: 'raw',
      createdAt: new Date(0),
    });
    return this.versions.length;
  }
}

function setup() {
  const repository = new InMemoryRepository();
  const service = new ProductConfigService(
    repository as unknown as ProductConfigRepository,
    testRegistry,
  );
  return { repository, service };
}

describe('ProductConfigService', () => {
  describe('reading the active version', () => {
    it('returns typed values from the active version', async () => {
      const { service } = setup();
      const created = await service.createVersion(validValues, 'first');
      await service.activate(created.version);

      const config = await service.active();

      expect(config.version).toBe(created.version);
      expect(config.get('test.minutes')).toBe(5);
      expect(config.get('test.enabled')).toBe(true);
      expect(config.get('test.milestones')).toEqual([3, 7]);
      expectTypeOf(config.get('test.minutes')).toEqualTypeOf<number>();
      expectTypeOf(config.get('test.enabled')).toEqualTypeOf<boolean>();
      expectTypeOf(config.get('test.milestones')).toEqualTypeOf<readonly number[]>();
    });

    it('fails clearly when no version is active', async () => {
      const { service } = setup();
      await expect(service.active()).rejects.toBeInstanceOf(NoActiveConfigVersionError);
    });

    it('changes the values it returns when the active version changes, with no code change', async () => {
      const { service } = setup();
      const v1 = await service.createVersion(validValues, 'v1');
      const v2 = await service.createVersion({ ...validValues, 'test.minutes': 10 }, 'v2');

      await service.activate(v1.version);
      expect((await service.active()).get('test.minutes')).toBe(5);

      await service.activate(v2.version);
      const config = await service.active();
      expect(config.version).toBe(v2.version);
      expect(config.get('test.minutes')).toBe(10);
    });
  });

  describe('reading older versions', () => {
    it('reads any stored version by number, whichever version is active', async () => {
      const { service } = setup();
      const v1 = await service.createVersion(validValues, 'v1');
      const v2 = await service.createVersion({ ...validValues, 'test.minutes': 10 }, 'v2');
      await service.activate(v2.version);

      const old = await service.version(v1.version);

      expect(old.version).toBe(v1.version);
      expect(old.get('test.minutes')).toBe(5);
    });

    it('fails clearly for a version that does not exist', async () => {
      const { service } = setup();
      await expect(service.version(42)).rejects.toBeInstanceOf(ConfigVersionNotFoundError);
      await expect(service.version(42)).rejects.toThrow(/version 42/);
    });

    it('fails clearly when an older version has no value for a newer key', async () => {
      const { repository, service } = setup();
      const version = repository.insertRaw({ 'test.enabled': true, 'test.milestones': [3] });

      const old = await service.version(version);

      expect(() => old.get('test.minutes')).toThrow(MissingConfigValueError);
      expect(() => old.get('test.minutes')).toThrow(/"test\.minutes".*version 1/);
    });
  });

  describe('key and type errors', () => {
    it('rejects an unknown key at compile time and at runtime', async () => {
      const { service } = setup();
      await service.activate((await service.createVersion(validValues, 'v1')).version);
      const config = await service.active();

      // @ts-expect-error: not a key in the registry
      expect(() => config.get('test.unknown')).toThrow(UnknownConfigKeyError);
      // @ts-expect-error: not a key in the registry
      expect(() => config.get('test.unknown')).toThrow(/"test\.unknown"/);
    });

    it('fails clearly when a stored value has the wrong type', async () => {
      const { repository, service } = setup();
      const version = repository.insertRaw({ ...validValues, 'test.minutes': '5' });

      const config = await service.version(version);

      expect(() => config.get('test.minutes')).toThrow(InvalidConfigValueError);
      expect(() => config.get('test.minutes')).toThrow(
        /"test\.minutes" in version 1 must be an integer ≥ 1, got "5"/,
      );
    });
  });

  describe('creating and activating versions', () => {
    it('rejects a new version with a missing key', async () => {
      const { service } = setup();
      const incomplete = { 'test.enabled': true, 'test.milestones': [3, 7] };
      await expect(service.createVersion(incomplete, 'bad')).rejects.toThrow(
        InvalidConfigVersionError,
      );
      await expect(service.createVersion(incomplete, 'bad')).rejects.toThrow(
        /test\.minutes.*missing/,
      );
    });

    it('rejects a new version with an unknown key', async () => {
      const { service } = setup();
      await expect(
        service.createVersion({ ...validValues, 'test.typo': 1 }, 'bad'),
      ).rejects.toThrow(/test\.typo.*unknown/);
    });

    it('rejects a new version with a wrongly typed value', async () => {
      const { service } = setup();
      await expect(
        service.createVersion({ ...validValues, 'test.enabled': 'yes' }, 'bad'),
      ).rejects.toThrow(/test\.enabled.*must be a boolean/);
    });

    it('refuses to activate a version that does not exist', async () => {
      const { service } = setup();
      await expect(service.activate(7)).rejects.toBeInstanceOf(ConfigVersionNotFoundError);
    });

    it('refuses to activate a version that is invalid for the current registry', async () => {
      const { repository, service } = setup();
      const version = repository.insertRaw({ 'test.enabled': true });

      await expect(service.activate(version)).rejects.toBeInstanceOf(InvalidConfigVersionError);
      await expect(service.active()).rejects.toBeInstanceOf(NoActiveConfigVersionError);
    });
  });

  it('returns values that callers cannot modify', async () => {
    const { service } = setup();
    await service.activate((await service.createVersion(validValues, 'v1')).version);
    const config = await service.active();

    expect(() => (config.get('test.milestones') as number[]).push(100)).toThrow(TypeError);
    expect(config.get('test.milestones')).toEqual([3, 7]);
  });

  it('keeps every value of one read from the same version', async () => {
    const { service } = setup();
    const v1 = await service.createVersion(validValues, 'v1');
    const v2 = await service.createVersion({ ...validValues, 'test.minutes': 10 }, 'v2');
    await service.activate(v1.version);

    const config = await service.active();
    await service.activate(v2.version);

    expect(config.version).toBe(v1.version);
    expect(config.get('test.minutes')).toBe(5);
  });
});
