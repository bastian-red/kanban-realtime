import { PrismaBoardRepository } from '@kan/board-store';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';

import { AuthModule } from './auth/auth.module';
import { BoardsController } from './boards/boards.controller';
import { BoardsService } from './boards/boards.service';
import { BoardErrorFilter } from './common/board-error.filter';
import { RATE_BUCKET_AUTH, RATE_BUCKET_GLOBAL, ResilientThrottlerGuard } from './common/rate-limit';
import { ServiceTokenGuard } from './common/service-token.guard';
import type { ApiConfig } from './config/config';
import { API_CONFIG, ConfigModule } from './config/config.module';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { PrismaModule } from './prisma/prisma.module';
import { PrismaService } from './prisma/prisma.service';
import { RealtimeEmitter } from './realtime/realtime.emitter';
import { RedisModule } from './redis/redis.module';
import { RedisService } from './redis/redis.service';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    RedisModule,
    AuthModule,
    /**
     * Rate-limit counters in Redis, not in process memory.
     *
     * The default in-memory storage gives each replica its own counters, so N
     * replicas multiply every limit by N -- and the auth limit, which exists
     * because scrypt is a denial-of-service lever pointed at us, is the one that
     * matters most. Sharing `RedisService`'s connection rather than opening
     * another means one place decides the offline behaviour and one socket closes
     * on shutdown.
     */
    ThrottlerModule.forRootAsync({
      imports: [RedisModule],
      inject: [API_CONFIG, RedisService],
      useFactory: (config: ApiConfig, redis: RedisService) => ({
        throttlers: [
          { name: RATE_BUCKET_GLOBAL, ttl: 60_000, limit: config.rateLimits.global },
          { name: RATE_BUCKET_AUTH, ttl: 60_000, limit: config.rateLimits.auth },
        ],
        storage: new ThrottlerStorageRedisService(redis.client),
      }),
    }),
  ],
  controllers: [HealthController, BoardsController],
  providers: [
    HealthService,
    BoardsService,
    RealtimeEmitter,
    /**
     * The repository is a plain class in `@kan/board-store`, not a `@Injectable()`
     * of this app's, and it is registered by factory for that reason.
     *
     * The gateway constructs the same class with a bare `PrismaClient`. Decorating
     * it would tie a package two processes share to Nest's DI, which the gateway
     * does not run -- and the alternative, a second copy carrying the decorators,
     * is exactly the drift the shared package exists to prevent.
     */
    {
      provide: PrismaBoardRepository,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => new PrismaBoardRepository(prisma),
    },
    // Order matters: the throttler runs before the token guard, so an unauthenticated
    // flood is refused without doing the JWT verification work it is trying to make
    // us do.
    { provide: APP_GUARD, useClass: ResilientThrottlerGuard },
    { provide: APP_GUARD, useClass: ServiceTokenGuard },
    { provide: APP_FILTER, useClass: BoardErrorFilter },
  ],
})
export class AppModule {}
