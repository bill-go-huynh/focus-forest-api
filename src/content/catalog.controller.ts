import { Body, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';

import {
  AdminController,
  AdminRoles,
  CurrentAdmin,
  type AuthenticatedAdmin,
} from '../admin/admin-route.decorator.js';
import { type CatalogDetail, CatalogService, type CatalogItem } from './catalog.service.js';

/**
 * The content catalog (A6.4, docs/09 later admin): badges, achievements, species, and cosmetics.
 * Bodies are checked by `catalog-rules.ts`, which answers every problem at once (422).
 */
@AdminController('content')
@AdminRoles('admin', 'content')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get(':kind')
  list(@Param('kind') kind: string): Promise<{ items: CatalogItem[] }> {
    return this.catalog.list(kind);
  }

  @Get(':kind/:id')
  detail(@Param('kind') kind: string, @Param('id') id: string): Promise<CatalogDetail> {
    return this.catalog.detail(kind, id);
  }

  @Post(':kind')
  create(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('kind') kind: string,
    @Body() body: Record<string, unknown>,
  ): Promise<CatalogItem> {
    return this.catalog.create(admin.adminId, kind, body);
  }

  @Patch(':kind/:id')
  update(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ): Promise<CatalogItem> {
    return this.catalog.update(admin.adminId, kind, id, body);
  }

  @Delete(':kind/:id')
  @HttpCode(204)
  remove(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Body() body: { reason?: unknown },
  ): Promise<void> {
    return this.catalog.remove(admin.adminId, kind, id, body.reason);
  }
}
