import { Get, Query } from '@nestjs/common';

import { AdminAuditService, type AuditPage } from './admin-audit.service.js';
import { AdminController, AdminRoles } from './admin-route.decorator.js';
import { AuditQueryDto } from './dto/admin-audit.dto.js';

@AdminController('audit-log')
@AdminRoles('admin')
export class AdminAuditController {
  constructor(private readonly audit: AdminAuditService) {}

  /** Newest first, 50 per page (docs/09 → Audit log). Admins only. */
  @Get()
  list(@Query() query: AuditQueryDto): Promise<AuditPage> {
    return this.audit.list(query.cursor ?? null);
  }
}
