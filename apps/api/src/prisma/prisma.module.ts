import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/** Global for the same reason as `ConfigModule`: every feature module reads the board. */
@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
