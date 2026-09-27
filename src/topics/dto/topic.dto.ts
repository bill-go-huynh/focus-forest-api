import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MinLength, ValidateBy, ValidateIf } from 'class-validator';

import type { TopicStatus } from '../../generated/prisma/client.js';
import {
  canonicalText,
  codePointLength,
  isTopicColor,
  isTopicIcon,
  TOPIC_DESCRIPTION_MAX_LENGTH,
  TOPIC_NAME_MAX_LENGTH,
} from '../topic-fields.js';

const canonical = ({ value }: { value: unknown }): unknown => canonicalText(value);

const canonicalOrNull = ({ value }: { value: unknown }): unknown => {
  const text = canonicalText(value);
  return text === '' ? null : text;
};

// `@ValidateIf(... !== undefined)` makes a field optional but still rejects null.
const isSent =
  (key: string) =>
  (dto: object): boolean =>
    (dto as Record<string, unknown>)[key] !== undefined;

function MaxCharacters(max: number): PropertyDecorator {
  return ValidateBy({
    name: 'maxCharacters',
    validator: {
      validate: (value) => typeof value === 'string' && codePointLength(value) <= max,
      defaultMessage: (args) => `${args?.property ?? 'value'} can be at most ${max} characters.`,
    },
  });
}

function IsTopicColor(): PropertyDecorator {
  return ValidateBy({
    name: 'isTopicColor',
    validator: {
      validate: (value) => isTopicColor(value),
      defaultMessage: () => 'color must be one of topic.1 to topic.12.',
    },
  });
}

function IsTopicIcon(): PropertyDecorator {
  return ValidateBy({
    name: 'isTopicIcon',
    validator: {
      validate: (value) => isTopicIcon(value),
      defaultMessage: () => 'icon must be an icon identifier, such as "book".',
    },
  });
}

/** The body of PUT /me/topics/:id. Unknown fields are rejected by the ValidationPipe. */
export class CreateTopicDto {
  @Transform(canonical)
  @IsString({ message: 'name must be text.' })
  @MinLength(1, { message: 'name cannot be empty.' })
  @MaxCharacters(TOPIC_NAME_MAX_LENGTH)
  name!: string;

  @IsTopicIcon()
  icon!: string;

  @IsTopicColor()
  color!: string;

  /** Null or blank means no description. */
  @Transform(canonicalOrNull)
  @IsOptional()
  @IsString({ message: 'description must be text.' })
  @MaxCharacters(TOPIC_DESCRIPTION_MAX_LENGTH)
  description?: string | null;
}

/** The body of PATCH /me/topics/:id: only the fields that change. */
export class UpdateTopicDto {
  @ValidateIf(isSent('name'))
  @Transform(canonical)
  @IsString({ message: 'name must be text.' })
  @MinLength(1, { message: 'name cannot be empty.' })
  @MaxCharacters(TOPIC_NAME_MAX_LENGTH)
  name?: string;

  @ValidateIf(isSent('icon'))
  @IsTopicIcon()
  icon?: string;

  @ValidateIf(isSent('color'))
  @IsTopicColor()
  color?: string;

  /** Null or blank clears the description. */
  @Transform(canonicalOrNull)
  @IsOptional()
  @IsString({ message: 'description must be text.' })
  @MaxCharacters(TOPIC_DESCRIPTION_MAX_LENGTH)
  description?: string | null;
}

const STATUSES: readonly TopicStatus[] = ['active', 'archived'];

export const TOPIC_SORTS = ['recent'] as const;
export type TopicSort = (typeof TOPIC_SORTS)[number];

export class ListTopicsQuery {
  /** Without a status, both active and archived topics are listed. */
  @ValidateIf(isSent('status'))
  @IsIn(STATUSES, { message: 'status must be active or archived.' })
  status?: TopicStatus;

  /**
   * `recent`: used topics by latest session first, then unused ones in creation order.
   * Without a sort, creation order. The status decides which topics, the sort only the order.
   */
  @ValidateIf(isSent('sort'))
  @IsIn(TOPIC_SORTS, { message: 'sort must be recent.' })
  sort?: TopicSort;
}

export interface TopicResponse {
  id: string;
  name: string;
  icon: string;
  color: string;
  description: string | null;
  status: TopicStatus;
  /** ISO 8601, or null while the topic is active. */
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  // Read metadata derived from the latest persisted session (any status,
  // `started_at DESC, id DESC`), never stored on the topic. Null until the topic has a session.
  /** The start of the latest session. */
  lastUsedAt: string | null;
  /** The planned minutes of that same session: the duration the picker remembers. */
  lastPlannedMinutes: number | null;
}
