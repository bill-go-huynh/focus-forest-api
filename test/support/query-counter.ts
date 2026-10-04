import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../src/generated/prisma/client.js';

/** Counts the SQL statements an app sends, to check that a request's queries stay bounded. */
export class QueryCounter {
  count = 0;

  /** Statements sent while `body` runs. */
  async during(body: () => Promise<unknown>): Promise<number> {
    const before = this.count;
    await body();
    return this.count - before;
  }
}

type Adapter = Awaited<ReturnType<PrismaPg['connect']>>;
type Transaction = Awaited<ReturnType<Adapter['startTransaction']>>;

/** A Prisma client whose driver adapter counts every query and statement, transactions included. */
export function countingPrismaClient(
  connectionString: string,
  counter: QueryCounter,
): PrismaClient {
  const base = new PrismaPg({ connectionString });
  const counted = <T extends Adapter | Transaction>(target: T): T =>
    new Proxy(target, {
      get(object, property, receiver) {
        const value: unknown = Reflect.get(object, property, receiver);
        if (typeof value !== 'function') return value;
        if (property === 'queryRaw' || property === 'executeRaw') {
          return (...args: unknown[]) => {
            counter.count += 1;
            return (value as (...a: unknown[]) => unknown).apply(object, args);
          };
        }
        if (property === 'startTransaction') {
          return async (...args: unknown[]) =>
            counted(await (value as (...a: unknown[]) => Promise<Transaction>).apply(object, args));
        }
        return (value as (...a: unknown[]) => unknown).bind(object);
      },
    });
  const factory = Object.create(base) as PrismaPg;
  factory.connect = async () => counted(await base.connect());
  const client = new PrismaClient({ adapter: factory });
  // Disconnects with the app, like PrismaService.
  return Object.assign(client, { onModuleDestroy: () => client.$disconnect() });
}
