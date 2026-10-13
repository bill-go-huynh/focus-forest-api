import { INestApplication, ValidationPipe } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import helmet from 'helmet';

import { requestId } from './monitoring/request-id.middleware.js';
import { ServerErrorFilter } from './monitoring/server-error.filter.js';

// HTTP-level setup shared by main.ts and the e2e tests.
export function configureApp(app: INestApplication): void {
  app.use(helmet());
  // A7.4: a request id on every response, and one structured log line per unexpected error.
  app.use(requestId);
  app.useGlobalFilters(new ServerErrorFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  // A5.4: plain WebSockets for the Focus Together live channel (docs/08 §6).
  app.useWebSocketAdapter(new WsAdapter(app));
  app.enableShutdownHooks();
}
