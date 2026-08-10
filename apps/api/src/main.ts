/**
 * The process.
 *
 * `reflect-metadata` is imported first, before anything that carries a decorator,
 * because Nest's DI reads metadata that the decorators write at module-evaluation
 * time. An import ordered after a controller works by accident until a bundler
 * reorders it.
 *
 * The boot sequence has one property worth stating: **every reason this process
 * will not work is discovered before it accepts a request.** `loadConfig` parses
 * and refuses on a malformed variable, `assertBootable` refuses on a value whose
 * shape is fine and whose meaning is not, and `PrismaService.onModuleInit`
 * connects eagerly so an unreachable database is a process that did not start
 * rather than a route that 500s. A `ConfigError` prints its own message and exits
 * 1; it never prints a stack, because the message names the variable and the
 * stack names this file.
 */
import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module';
import { assertBootable } from './config/boot';
import { ConfigError, loadConfig } from './config/config';
import { PrismaService } from './prisma/prisma.service';

async function bootstrap(): Promise<void> {
  const logger = new Logger('bootstrap');

  // Loaded here as well as inside `ConfigModule`, on purpose. `loadConfig` is
  // pure and cheap, and reading it before `NestFactory.create` is what turns a
  // bad variable into one printed line instead of a Nest dependency-resolution
  // stack with the real message four frames down.
  const config = loadConfig();
  assertBootable(config);

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // The API is not browser-facing: every call comes from the web app's server
    // side or from the realtime gateway, carrying a service token. There is no
    // CORS configuration because there is no origin to allow, and adding one
    // would be inviting the browser to talk to it directly with a token it
    // should never hold. The browser's live connection is the socket, which is
    // a different process with its own origin policy.
    cors: false,
    bufferLogs: false,
  });

  // No global `ValidationPipe`. Nest's built-in pipe wraps class-validator, which
  // this API does not use and does not install: every handler validates with
  // `ZodValidationPipe` against the same schema the web app and the gateway parse
  // with, so there is exactly one description of each payload. Registering the
  // built-in anyway logs "The class-validator package is missing" at boot and
  // validates nothing, which is the worst of both.

  // Behind a reverse proxy the client address is in `X-Forwarded-For`, and the
  // rate limiter keys on the client address. Without this every request in
  // production shares one bucket -- the proxy's -- and the first user to hit the
  // limit locks out everyone else.
  app.set('trust proxy', 1);

  app.enableShutdownHooks();
  app.get(PrismaService).enableShutdownHooks(app);

  await app.listen(config.port, '0.0.0.0');
  logger.log(
    `API ${config.version} listening on http://0.0.0.0:${config.port} (${config.nodeEnv})`,
  );
}

void bootstrap().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    // The logger is part of the app that failed to start, so this writes direct.
    console.error(error.message);
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
});
