import { IsIn, IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';

export const DEVICE_PLATFORMS = ['ios', 'android'] as const;
/** Expo push tokens: `ExponentPushToken[…]` (or the newer `ExpoPushToken[…]`). */
export const PUSH_TOKEN = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/;

export class RegisterDeviceDto {
  @IsIn(DEVICE_PLATFORMS, { message: 'platform must be ios or android.' })
  platform!: (typeof DEVICE_PLATFORMS)[number];

  @IsOptional()
  @IsString()
  @MaxLength(32)
  appVersion?: string;
}

export interface DeviceResponse {
  token: string;
  platform: string;
  registeredAt: string;
}

export class FocusLeaseDto {
  @IsISO8601({ strict: true }, { message: 'endsAt must be an ISO 8601 instant.' })
  endsAt!: string;
}

export interface FocusLeaseResponse {
  endsAt: string;
}
