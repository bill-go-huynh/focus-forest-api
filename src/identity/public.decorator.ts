import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'identity:isPublic';

/** Opts a route out of the global access-token guard. Every other route requires sign-in. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);
