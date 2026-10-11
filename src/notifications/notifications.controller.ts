import { Body, Controller, Delete, HttpCode, Param, Put } from '@nestjs/common';

import { CurrentUser, type AuthenticatedUser } from '../identity/current-user.decorator.js';
import { DevicesService } from './devices.service.js';
import {
  type DeviceResponse,
  FocusLeaseDto,
  type FocusLeaseResponse,
  RegisterDeviceDto,
} from './notifications.dto.js';

@Controller('me/devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Put(':token')
  register(
    @CurrentUser() user: AuthenticatedUser,
    @Param('token') token: string,
    @Body() input: RegisterDeviceDto,
  ): Promise<DeviceResponse> {
    return this.devices.register(user.userId, token, input);
  }

  @Delete(':token')
  @HttpCode(204)
  unregister(@CurrentUser() user: AuthenticatedUser, @Param('token') token: string): Promise<void> {
    return this.devices.unregister(user.userId, token);
  }
}

@Controller('me/focus/active')
export class FocusLeaseController {
  constructor(private readonly devices: DevicesService) {}

  @Put()
  start(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: FocusLeaseDto,
  ): Promise<FocusLeaseResponse> {
    return this.devices.startFocus(user.userId, input.endsAt);
  }

  @Delete()
  @HttpCode(204)
  end(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    return this.devices.endFocus(user.userId);
  }
}
