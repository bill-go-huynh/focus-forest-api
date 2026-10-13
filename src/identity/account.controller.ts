import { Body, Controller, Delete, Get, Header, HttpCode } from '@nestjs/common';

import { AccountService } from './account.service.js';
import { CurrentUser, type AuthenticatedUser } from './current-user.decorator.js';
import { DeleteAccountDto } from './dto/account.dto.js';
import { RateLimit } from '../safety/rate-limit.decorator.js';

/** A7.1 The signed-in person's own account: a copy of their data, and deletion. */
@Controller('me')
export class AccountController {
  constructor(private readonly account: AccountService) {}

  @Get('export')
  @Header('Content-Disposition', 'attachment; filename="focus-forest-export.json"')
  export(@CurrentUser() user: AuthenticatedUser): Promise<Record<string, unknown>> {
    return this.account.export(user.userId);
  }

  /** Deletes the account and everything it owns, at once. The password confirms it. */
  @RateLimit('deleteAttempts', 'user')
  @Delete()
  @HttpCode(204)
  delete(@CurrentUser() user: AuthenticatedUser, @Body() body: DeleteAccountDto): Promise<void> {
    return this.account.delete(user.userId, body.password);
  }
}
