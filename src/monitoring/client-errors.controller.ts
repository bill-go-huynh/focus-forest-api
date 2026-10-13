import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';

import { AdminController, AdminRoles } from '../admin/admin-route.decorator.js';
import { Public } from '../identity/public.decorator.js';
import { RateLimit } from '../safety/rate-limit.decorator.js';
import { ClientErrorsService, type ClientErrorGroup } from './client-errors.service.js';
import { ClientErrorBatchDto, ClientErrorQueryDto } from './dto/client-errors.dto.js';

/** A7.4 The apps report what went wrong, signed in or not (a crash can come first). */
@Public()
@Controller('client-errors')
export class ClientErrorsController {
  constructor(private readonly errors: ClientErrorsService) {}

  @Post()
  @HttpCode(202)
  @RateLimit('clientErrors', 'ip')
  report(@Body() body: ClientErrorBatchDto): Promise<{ accepted: number }> {
    return this.errors.record(body.errors);
  }
}

/** A7.4 Staff read the reports grouped (admins and support). */
@AdminController('client-errors')
@AdminRoles('admin', 'support')
export class AdminClientErrorsController {
  constructor(private readonly errors: ClientErrorsService) {}

  @Get()
  list(@Query() query: ClientErrorQueryDto): Promise<{ items: ClientErrorGroup[] }> {
    return this.errors.groups(query.days ?? 7);
  }
}
