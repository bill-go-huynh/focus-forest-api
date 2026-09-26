import { Controller, Get } from '@nestjs/common';

import { Public } from '../identity/public.decorator.js';

// Liveness only: reports that the process is up. Contains no product logic.
@Public()
@Controller('health')
export class HealthController {
  @Get()
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
