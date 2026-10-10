import { INestApplication, ValidationPipe } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import helmet from 'helmet';

// HTTP-level setup shared by main.ts and the e2e tests.
export function configureApp(app: INestApplication): void {
  app.use(helmet());
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
