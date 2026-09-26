import { Injectable } from '@nestjs/common';

import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface StoredConfigVersion {
  version: number;
  values: Readonly<Record<string, unknown>>;
  note: string;
  createdAt: Date;
}

// The only code that touches the configuration tables. Everything else goes
// through ProductConfigService. Versions are never updated or deleted.
@Injectable()
export class ProductConfigRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findVersion(version: number): Promise<StoredConfigVersion | null> {
    const row = await this.prisma.productConfigVersion.findUnique({ where: { version } });
    return row ? toStored(row) : null;
  }

  async findActiveVersion(): Promise<StoredConfigVersion | null> {
    const active = await this.prisma.activeProductConfig.findUnique({
      where: { id: true },
      include: { configVersion: true },
    });
    return active ? toStored(active.configVersion) : null;
  }

  async createVersion(
    values: Readonly<Record<string, unknown>>,
    note: string,
  ): Promise<StoredConfigVersion> {
    const row = await this.prisma.productConfigVersion.create({
      data: { values: values as Prisma.InputJsonObject, note },
    });
    return toStored(row);
  }

  async setActiveVersion(version: number): Promise<void> {
    await this.prisma.activeProductConfig.upsert({
      where: { id: true },
      create: { id: true, version },
      update: { version },
    });
  }
}

function toStored(row: {
  version: number;
  values: Prisma.JsonValue;
  note: string;
  createdAt: Date;
}): StoredConfigVersion {
  const { values } = row;
  if (typeof values !== 'object' || values === null || Array.isArray(values)) {
    throw new Error(`Product configuration version ${row.version} is not a key/value object.`);
  }
  return { version: row.version, values, note: row.note, createdAt: row.createdAt };
}
