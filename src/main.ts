import { ConsoleLogger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { EnvironmentVariables, NodeEnv } from './config/env.validation.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: new ConsoleLogger({ json: process.env['NODE_ENV'] === NodeEnv.Production }),
  });
  const config = app.get(ConfigService<EnvironmentVariables, true>);

  configureApp(app);

  if (config.get('NODE_ENV', { infer: true }) !== NodeEnv.Production) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('Focus Forest API').setVersion('0.1.0').build(),
    );
    SwaggerModule.setup('docs', app, document);
  }

  await app.listen(config.get('PORT', { infer: true }));
}
await bootstrap();
