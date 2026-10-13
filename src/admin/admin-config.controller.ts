import { Body, Get, HttpCode, Param, ParseIntPipe, Post } from '@nestjs/common';

import { AdminConfigService, type ConfigVersionRow } from './admin-config.service.js';
import {
  AdminController,
  AdminRoles,
  CurrentAdmin,
  type AuthenticatedAdmin,
} from './admin-route.decorator.js';

/** Configuration versions (A6.6, docs/09 → Configuration). Admins only (owner decision 8). */
@AdminController('config/versions')
@AdminRoles('admin')
export class AdminConfigController {
  constructor(private readonly versions: AdminConfigService) {}

  @Get()
  list(): Promise<{ items: ConfigVersionRow[] }> {
    return this.versions.list();
  }

  @Get(':version')
  one(@Param('version', ParseIntPipe) version: number) {
    return this.versions.one(version);
  }

  @Get(':version/diff')
  diff(@Param('version', ParseIntPipe) version: number) {
    return this.versions.diff(version);
  }

  @Get(':version/preview')
  preview(@Param('version', ParseIntPipe) version: number) {
    return this.versions.preview(version);
  }

  @Post()
  propose(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body() body: Record<string, unknown>,
  ): Promise<ConfigVersionRow> {
    return this.versions.propose(admin.adminId, body);
  }

  @Post(':version/activate')
  @HttpCode(200)
  activate(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('version', ParseIntPipe) version: number,
    @Body() body: Record<string, unknown>,
  ): Promise<ConfigVersionRow> {
    return this.versions.activate(admin.adminId, version, body['reason']);
  }
}
