import { migrateFreshTestDatabase } from './test-database.js';

// Every integration run starts from an empty database with all migrations applied.
export default async function setup(): Promise<void> {
  await migrateFreshTestDatabase();
}
