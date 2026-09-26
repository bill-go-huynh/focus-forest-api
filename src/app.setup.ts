import { INestApplication, ValidationPipe } from '@nestjs/common';
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
  app.enableShutdownHooks();
}
