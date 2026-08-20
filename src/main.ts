import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('v2');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  // слушаем только loopback: наружу нас отдаёт nginx (api.hitrack.am/v2/)
  const host = process.env.HOST ?? '127.0.0.1';
  await app.listen(port, host);
  console.log(`hitrac-api listening on ${host}:${port}`);
}

bootstrap();
