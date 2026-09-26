import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsObject, Matches, ValidateIf, ValidateNested } from 'class-validator';

import type { Theme } from '../../generated/prisma/client.js';
import { REMINDER_TIME, type NotificationCategoryKey } from '../notification-categories.js';

const THEMES: readonly Theme[] = ['system', 'light', 'dark'];

// `@ValidateIf(... !== undefined)` makes a field optional but still rejects null.
const isSent =
  (key: string) =>
  (dto: object): boolean =>
    (dto as Record<string, unknown>)[key] !== undefined;

export class NotificationSettingDto {
  @ValidateIf(isSent('enabled'))
  @IsBoolean({ message: 'enabled must be true or false.' })
  enabled?: boolean;
}

export class ReminderSettingDto extends NotificationSettingDto {
  /** Local "HH:MM". Null clears it. */
  @ValidateIf((dto: ReminderSettingDto) => dto.time !== undefined && dto.time !== null)
  @Matches(REMINDER_TIME, { message: 'time must be a local 24-hour time, such as "19:30".' })
  time?: string | null;
}

function Setting(dto: typeof NotificationSettingDto): PropertyDecorator {
  return (target, key) => {
    ValidateIf(isSent(String(key)))(target, key);
    IsObject({ message: `${String(key)} must be an object.` })(target, key);
    ValidateNested()(target, key);
    Type(() => dto)(target, key);
  };
}

/** Any subset of the spec §18 categories. Other keys are rejected. */
export class NotificationPreferencesDto implements Partial<
  Record<NotificationCategoryKey, NotificationSettingDto>
> {
  @Setting(ReminderSettingDto) dailyGoalReminder?: ReminderSettingDto;
  @Setting(ReminderSettingDto) scheduledFocusReminder?: ReminderSettingDto;
  @Setting(ReminderSettingDto) streakReminder?: ReminderSettingDto;
  @Setting(NotificationSettingDto) eventStart?: NotificationSettingDto;
  @Setting(NotificationSettingDto) eventEndingSoon?: NotificationSettingDto;
  @Setting(NotificationSettingDto) friendInvite?: NotificationSettingDto;
  @Setting(NotificationSettingDto) focusRoomInvite?: NotificationSettingDto;
  @Setting(NotificationSettingDto) challengeUpdate?: NotificationSettingDto;
  @Setting(NotificationSettingDto) badgeUnlocked?: NotificationSettingDto;
  @Setting(NotificationSettingDto) monthlyRecapReady?: NotificationSettingDto;
}

/** Every field is optional and changes independently. Unknown fields are rejected. */
export class UpdatePreferencesDto {
  @ValidateIf(isSent('theme'))
  @IsIn(THEMES, { message: 'theme must be one of: system, light, dark.' })
  theme?: Theme;

  @ValidateIf(isSent('sound'))
  @IsBoolean({ message: 'sound must be true or false.' })
  sound?: boolean;

  @ValidateIf(isSent('haptics'))
  @IsBoolean({ message: 'haptics must be true or false.' })
  haptics?: boolean;

  @ValidateIf(isSent('reducedMotion'))
  @IsBoolean({ message: 'reducedMotion must be true or false.' })
  reducedMotion?: boolean;

  @ValidateIf(isSent('notifications'))
  @IsObject({ message: 'notifications must be an object.' })
  @ValidateNested()
  @Type(() => NotificationPreferencesDto)
  notifications?: NotificationPreferencesDto;
}

export interface NotificationSettingResponse {
  enabled: boolean;
}

export interface ReminderSettingResponse extends NotificationSettingResponse {
  time: string | null;
}

export interface PreferencesResponse {
  theme: Theme;
  sound: boolean;
  haptics: boolean;
  reducedMotion: boolean;
  notifications: Record<
    NotificationCategoryKey,
    NotificationSettingResponse | ReminderSettingResponse
  >;
}
