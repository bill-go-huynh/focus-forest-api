import { createTestPrismaClient, resetTestDatabase } from './test-database.js';

// Loaded for every integration test file: each test starts with empty tables.
const prisma = createTestPrismaClient();

beforeEach(async () => {
  await resetTestDatabase(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});
