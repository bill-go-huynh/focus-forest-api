import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import {
  configDiff,
  previewSamples,
  type ConfigChange,
  type SamplePreview,
} from '../product-config/config-preview.js';
import { InvalidConfigVersionError } from '../product-config/product-config.errors.js';
import { ProductConfigService } from '../product-config/product-config.service.js';
import { growthRulesFrom } from '../trees/growth-rules.js';
import { AdminAuditService } from './admin-audit.service.js';

export interface ConfigVersionRow {
  version: number;
  note: string;
  createdAt: string;
  active: boolean;
}

/**
 * Configuration versions (A6.6; docs/09 → Configuration: versions, diff, sample-month preview,
 * activation). Admins only. A version is complete and valid for the registry before it is
 * stored; activating it changes what new growth uses, never an archived tree (trees record the
 * version they grew under). Proposals and activations are audited.
 */
@Injectable()
export class AdminConfigService {
  constructor(
    private readonly config: ProductConfigService,
    private readonly audit: AdminAuditService,
  ) {}

  async list(): Promise<{ items: ConfigVersionRow[] }> {
    const active = await this.activeVersion();
    const rows = await this.config.versions();
    return {
      items: rows.map((row) => ({
        version: row.version,
        note: row.note,
        createdAt: row.createdAt.toISOString(),
        active: row.version === active,
      })),
    };
  }

  async one(version: number): Promise<ConfigVersionRow & { values: Record<string, unknown> }> {
    const row = await this.find(version);
    return {
      version: row.version,
      note: row.note,
      createdAt: row.createdAt.toISOString(),
      active: row.version === (await this.activeVersion()),
      values: { ...row.values },
    };
  }

  async propose(adminId: string, body: Record<string, unknown>): Promise<ConfigVersionRow> {
    const note = typeof body['note'] === 'string' ? body['note'].trim() : '';
    const reason = typeof body['reason'] === 'string' ? body['reason'].trim() : '';
    const values = body['values'];
    const problems: string[] = [];
    if (note.length < 3 || note.length > 200)
      problems.push('note must say what changes, in 3 to 200 characters.');
    if (reason.length < 3 || reason.length > 500)
      problems.push('reason must say why, in 3 to 500 characters.');
    if (typeof values !== 'object' || values === null || Array.isArray(values)) {
      problems.push('values must be the whole configuration, key by key.');
    }
    if (problems.length > 0) throw invalidConfig(problems);
    try {
      const created = await this.config.createVersion(values as Record<string, unknown>, note);
      await this.audit.record({
        adminId,
        action: 'config.propose',
        targetType: 'config_version',
        targetId: String(created.version),
        reason,
        details: { note },
      });
      return this.one(created.version);
    } catch (error) {
      if (error instanceof InvalidConfigVersionError) throw invalidConfig([...error.problems]);
      throw error;
    }
  }

  async diff(version: number): Promise<{ against: number; changes: ConfigChange[] }> {
    const proposed = await this.find(version);
    const against = await this.activeVersion();
    const active = await this.find(against);
    return {
      against,
      changes: configDiff(active.values, proposed.values),
    };
  }

  async preview(version: number): Promise<{ against: number; samples: SamplePreview[] }> {
    await this.find(version);
    const active = await this.config.active();
    const proposed = await this.config.version(version);
    return {
      against: active.version,
      samples: previewSamples(growthRulesFrom(active), growthRulesFrom(proposed)),
    };
  }

  async activate(adminId: string, version: number, reason: unknown): Promise<ConfigVersionRow> {
    if (typeof reason !== 'string' || reason.trim().length < 3 || reason.trim().length > 500) {
      throw invalidConfig(['reason must say why, in 3 to 500 characters.']);
    }
    await this.find(version);
    const from = await this.activeVersion();
    if (from === version) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: `Version ${version} is already active.`,
        code: 'already_active',
      });
    }
    try {
      await this.config.activate(version);
    } catch (error) {
      if (error instanceof InvalidConfigVersionError) throw invalidConfig([...error.problems]);
      throw error;
    }
    await this.audit.record({
      adminId,
      action: 'config.activate',
      targetType: 'config_version',
      targetId: String(version),
      reason: reason.trim(),
      details: { from, to: version },
    });
    return this.one(version);
  }

  private async activeVersion(): Promise<number> {
    return (await this.config.active()).version;
  }

  private async find(version: number) {
    const row = await this.config.stored(version);
    if (!row) {
      throw new NotFoundException({
        statusCode: 404,
        error: 'Not Found',
        message: `There is no configuration version ${version}.`,
        code: 'config_version_not_found',
      });
    }
    return row;
  }
}

function invalidConfig(problems: string[]): UnprocessableEntityException {
  return new UnprocessableEntityException({
    statusCode: 422,
    error: 'Unprocessable Entity',
    message: problems.join(' '),
    code: 'invalid_config',
    problems,
  });
}
