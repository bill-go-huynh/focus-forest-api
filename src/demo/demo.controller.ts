import {
  Body,
  CanActivate,
  Get,
  Injectable,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';

import {
  AdminController,
  AdminRoles,
  CurrentAdmin,
  type AuthenticatedAdmin,
} from '../admin/admin-route.decorator.js';
import type { EnvironmentVariables } from '../config/env.validation.js';
import {
  DEMO_CATEGORIES,
  DEMO_PERSONAS,
  DemoService,
  type DemoCategory,
  type DemoNotifyResult,
  type DemoPersona,
  type DemoWorld,
} from './demo.service.js';

/** Off (404) unless DEMO_TOOLS=on; env validation already refuses it in production. */
@Injectable()
export class DemoEnabledGuard implements CanActivate {
  constructor(private readonly config: ConfigService<EnvironmentVariables, true>) {}
  canActivate(): boolean {
    if (this.config.get('DEMO_TOOLS', { infer: true }) !== 'on') throw new NotFoundException();
    return true;
  }
}

export class CreateWorldDto {
  @IsString()
  @Length(8, 128, { message: 'password has 8 to 128 characters.' })
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class NotifyDto {
  @IsIn(DEMO_PERSONAS)
  persona!: DemoPersona;

  @IsIn(DEMO_CATEGORIES)
  category!: DemoCategory;
}

/** DM.1 Demo tools (spec/demo/PLAN.md): admin role only. */
@AdminController('demo')
@AdminRoles('admin')
export class DemoController {
  constructor(
    private readonly demo: DemoService,
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  /** Whether the tools are on, so the admin app can show or hide its Demo page. */
  @Get('status')
  status(): { enabled: boolean } {
    return { enabled: this.config.get('DEMO_TOOLS', { infer: true }) === 'on' };
  }

  @UseGuards(DemoEnabledGuard)
  @Get('worlds')
  worlds(): Promise<{ items: DemoWorld[] }> {
    return this.demo.worlds();
  }

  @UseGuards(DemoEnabledGuard)
  @Post('worlds')
  create(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body() body: CreateWorldDto,
  ): Promise<DemoWorld> {
    return this.demo.createWorld(admin.adminId, body.password, body.reason?.trim() || 'Demo');
  }

  @UseGuards(DemoEnabledGuard)
  @Post('worlds/:id/notify')
  notify(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: NotifyDto,
  ): Promise<DemoNotifyResult> {
    return this.demo.notify(admin.adminId, id, body.persona, body.category);
  }

  @UseGuards(DemoEnabledGuard)
  @Post('worlds/:id/friend-ready')
  friendReady(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<unknown> {
    return this.demo.friendReady(admin.adminId, id);
  }
}
