import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { NodeEnv, type EnvironmentVariables } from '../config/env.validation.js';
import { LogMailer, Mailer, SmtpMailer } from './mailer.js';

/** W.3 The app's mailer: SMTP when SMTP_URL is set, else the log (development) or nothing. */
@Global()
@Module({
  providers: [
    {
      provide: Mailer,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) => {
        const smtpUrl = config.get('SMTP_URL', { infer: true });
        if (smtpUrl) return new SmtpMailer(smtpUrl, config.get('MAIL_FROM', { infer: true }));
        return new LogMailer(config.get('NODE_ENV', { infer: true }) === NodeEnv.Development);
      },
    },
  ],
  exports: [Mailer],
})
export class MailModule {}
