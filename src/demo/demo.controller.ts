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
import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

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

/** Off (404) unless DEMO_TOOLS=on. */
@Injectable()
export class DemoEnabledGuard implements CanActivate {
  constructor(private readonly config: ConfigService<EnvironmentVariables, true>) {}
  canActivate(): boolean {
    if (this.config.get('DEMO_TOOLS', { infer: true }) !== 'on') throw new NotFoundException();
    return true;
  }
}

/** Trimmed and lowercased; left blank, the persona gets its generated address. */
const entered = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  return value.trim().toLowerCase() || undefined;
};
const IsEnteredEmail = (): PropertyDecorator => (target, key) => {
  Transform(entered)(target, key);
  IsOptional()(target, key);
  IsEmail({}, { message: 'Enter a valid email address.' })(target, key);
  MaxLength(254)(target, key);
};

/** The address the admin chose for each persona, any of them left out. */
export class DemoEmailsDto implements Partial<Record<DemoPersona, string>> {
  @IsEnteredEmail() main?: string;
  @IsEnteredEmail() comeback?: string;
  @IsEnteredEmail() recovery?: string;
  @IsEnteredEmail() 'friend-mai'?: string;
  @IsEnteredEmail() 'friend-khoa'?: string;
  @IsEnteredEmail() 'friend-linh'?: string;
}

export class CreateWorldDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => DemoEmailsDto)
  emails?: DemoEmailsDto;
}

export class PersonaDto {
  @IsIn(DEMO_PERSONAS)
  persona!: DemoPersona;
}

export class AddSessionDto extends PersonaDto {
  @IsInt()
  @Min(5)
  @Max(180)
  minutes!: number;
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
    return this.demo.createWorld(admin.adminId, body.reason?.trim() || 'Demo', body.emails);
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
  @Post('worlds/:id/session')
  session(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: AddSessionDto,
  ): Promise<unknown> {
    return this.demo.addSession(admin.adminId, id, body.persona, body.minutes);
  }

  @UseGuards(DemoEnabledGuard)
  @Post('worlds/:id/rest-today')
  restToday(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: PersonaDto,
  ): Promise<unknown> {
    return this.demo.restToday(admin.adminId, id, body.persona);
  }

  @UseGuards(DemoEnabledGuard)
  @Post('worlds/:id/react')
  react(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: PersonaDto,
  ): Promise<unknown> {
    return this.demo.react(admin.adminId, id, body.persona);
  }

  @UseGuards(DemoEnabledGuard)
  @Post('worlds/:id/room')
  room(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ opened: true }> {
    return this.demo.openRoom(admin.adminId, id);
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
