import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';

import { Public } from '../identity/public.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Liveness and readiness. Contains no product logic. */
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** The process is up. */
  @Get()
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** A7.4: ready to serve: the database answers. */
  @Get('ready')
  async ready(): Promise<{ status: 'ok'; database: 'ok' }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({ status: 'unavailable', database: 'unavailable' });
    }
    return { status: 'ok', database: 'ok' };
  }
}
