import { ValidateBy, type ValidationOptions } from 'class-validator';

// "UTC", or an IANA Area/Location name such as "Europe/Zurich" or "Etc/GMT-7".
// Offsets ("+07:00"), abbreviations ("EST"), and lowercase names are refused.
const IANA_NAME = /^(?:UTC|[A-Z][A-Za-z_-]*(?:\/[A-Z0-9][A-Za-z0-9_+-]*)+)$/;
const MAX_LENGTH = 64;

/**
 * True when `value` is an IANA time zone name that this runtime can compute with.
 * The name is kept as given: runtimes resolve some zones to legacy aliases
 * (for example Asia/Ho_Chi_Minh to Asia/Saigon), and clients report current names.
 */
export function isIanaTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_LENGTH || !IANA_NAME.test(value)) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function IsIanaTimeZone(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isIanaTimeZone',
      validator: {
        validate: (value) => isIanaTimeZone(value),
        defaultMessage: (args) =>
          `${args?.property ?? 'value'} must be an IANA time zone name, such as "Europe/Zurich".`,
      },
    },
    options,
  );
}
