import { Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';

/** A plain-text email to one person. */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * W.3 Sends email: password reset codes. The app's only outgoing mail (owner decision
 * 2026-10-18: SMTP through nodemailer, any provider by configuration).
 */
export abstract class Mailer {
  abstract send(message: MailMessage): Promise<void>;
}

/** Sends through the SMTP server in SMTP_URL (for example Gmail with an app password). */
export class SmtpMailer extends Mailer {
  private readonly transport: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    super();
    this.transport = createTransport(smtpUrl);
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...message });
  }
}

/**
 * No SMTP configured. In development the message is written to the server log, so a reset can be
 * tried locally (it holds the code: development only). Elsewhere nothing is sent and a warning
 * says so, without the message.
 */
export class LogMailer extends Mailer {
  private readonly logger = new Logger('Mail');

  constructor(private readonly development: boolean) {
    super();
  }

  send(message: MailMessage): Promise<void> {
    if (this.development) {
      this.logger.log(`To ${message.to}: ${message.subject}\n${message.text}`);
    } else {
      this.logger.warn('Email is not configured (SMTP_URL): a message was not sent.');
    }
    return Promise.resolve();
  }
}
