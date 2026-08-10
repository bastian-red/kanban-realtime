import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';

/** Global for the same reason as `ConfigModule`: the cache and the rate limiter both want it. */
@Global()
@Module({ providers: [RedisService], exports: [RedisService] })
export class RedisModule {}
