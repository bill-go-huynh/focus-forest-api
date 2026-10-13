import { Get, Query } from '@nestjs/common';

import { AdminAuditService, type AuditPage } from './admin-audit.service.js';
import { AdminController, AdminRoles } from './admin-route.decorator.js';
import { AuditQueryDto } from './dto/admin-audit.dto.js';

@AdminController('audit-log')
@AdminRoles('admin')
export class AdminAuditController {
  constructor(private readonly audit: AdminAuditService) {}

  /** Newest first, 50 per page, filtered (docs/09 → Audit log: by admin, action, target). */
  @Get()
  list(@Query() query: AuditQueryDto): Promise<AuditPage> {
    const { cursor, ...filters } = query;
    return this.audit.list(cursor ?? null, filters);
  }
}
