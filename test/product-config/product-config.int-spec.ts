import { Test } from '@nestjs/testing';

import { AppModule } from '../../src/app.module.js';
import { integer, type ConfigRegistry } from '../../src/product-config/config-types.js';
import { productConfigRegistry } from '../../src/product-config/product-config.registry.js';
import { ProductConfigRepository } from '../../src/product-config/product-config.repository.js';
import { ProductConfigService } from '../../src/product-config/product-config.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { createTestPrismaClient, migrateFreshTestDatabase } from '../database/test-database.js';

const testRegistry = {
  'test.minutes': { description: 'A number of minutes', type: integer({ min: 1 }) },
} satisfies ConfigRegistry;

describe('product configuration (PostgreSQL)', () => {
  let prisma: PrismaService;
  let repository: ProductConfigRepository;
  let service: ProductConfigService<typeof testRegistry>;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    repository = moduleRef.get(ProductConfigRepository);
    service = new ProductConfigService(repository, testRegistry);
    close = () => moduleRef.close();
  });

  afterAll(async () => {
    await close();
  });

  it('keeps the initial empty version 1 and activates the Phase 2 session rules', async () => {
    await migrateFreshTestDatabase();
    const seeded = createTestPrismaClient();
    try {
      const productionService = new ProductConfigService(
        new ProductConfigRepository(seeded as PrismaService),
        productConfigRegistry,
      );

      const initial = await seeded.productConfigVersion.findUniqueOrThrow({
        where: { version: 1 },
      });
      expect(initial.values).toEqual({});
      expect(initial.note).toMatch(/initial/i);

      const config = await productionService.active();
      expect(config.version).toBe(2);
      expect(config.get('session.minValidMinutes')).toBe(5);
      expect(config.get('session.maxPauseMinutes')).toBe(30);
      // The active version is complete for the registry, so activating it again is accepted.
      await expect(productionService.activate(config.version)).resolves.toBeUndefined();
    } finally {
      await seeded.$disconnect();
    }
  });

  it('stores versions with increasing numbers and reads their values back', async () => {
    const v1 = await service.createVersion({ 'test.minutes': 5 }, 'first');
    const v2 = await service.createVersion({ 'test.minutes': 10 }, 'second');

    expect(v2.version).toBeGreaterThan(v1.version);
    expect((await service.version(v1.version)).get('test.minutes')).toBe(5);
    expect((await service.version(v2.version)).get('test.minutes')).toBe(10);
  });

  it('switches the active version and keeps exactly one active pointer', async () => {
    const v1 = await service.createVersion({ 'test.minutes': 5 }, 'first');
    const v2 = await service.createVersion({ 'test.minutes': 10 }, 'second');

    await service.activate(v1.version);
    expect((await service.active()).get('test.minutes')).toBe(5);

    await service.activate(v2.version);
    expect((await service.active()).get('test.minutes')).toBe(10);
    expect(await prisma.activeProductConfig.count()).toBe(1);
  });

  it('cannot point the active version at a version that does not exist', async () => {
    await expect(repository.setActiveVersion(999)).rejects.toThrow();
  });

  it('does not allow a second active pointer row', async () => {
    const v1 = await service.createVersion({ 'test.minutes': 5 }, 'first');
    await service.activate(v1.version);

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO active_product_config (id, version, activated_at) VALUES (false, ${v1.version}, now())`,
      ),
    ).rejects.toThrow();
  });

  it('provides ProductConfigService through dependency injection', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(moduleRef.get(ProductConfigService)).toBeInstanceOf(ProductConfigService);
    await moduleRef.close();
  });
});
