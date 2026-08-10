import { PrismaClient } from '@kan/db';
import {
  Inject,
  Injectable,
  Logger,
  type INestApplication,
  type OnModuleInit,
} from '@nestjs/common';
import { API_CONFIG } from '../config/config.module';
import type { ApiConfig } from '../config/config';

/**
 * The one Prisma client in the process.
 *
 * The connection URL is passed explicitly rather than left to Prisma's own
 * `env("DATABASE_URL")` lookup. Both read the same variable, but only the
 * explicit form goes through `loadConfig`, which means the API fails at boot with
 * a message naming the variable instead of failing on the first query with a
 * connection error that names a host of `undefined`.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  private readonly logger = new Logger(PrismaService.name);

  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    super({
      datasources: { db: { url: config.databaseUrl } },
      log: config.nodeEnv === 'development' ? ['warn', 'error'] : ['error'],
    });
  }

  async onModuleInit(): Promise<void> {
    // Connect eagerly. Prisma connects lazily on the first query otherwise, which
    // means a bad URL or an unreachable database shows up as one failed request
    // rather than as a process that refused to start.
    await this.$connect();
    this.logger.log('Connected to Postgres');
  }

  /**
   * Close the Nest application when Node is about to exit.
   *
   * Prisma 5's `$on('beforeExit')` is not available on the default library
   * engine, so this hooks Node's own event instead. Without it, an interrupted
   * process leaves the HTTP server accepting requests while the client is being
   * torn down, and an in-flight import commit can lose its transaction.
   */
  enableShutdownHooks(app: INestApplication): void {
    process.on('beforeExit', () => {
      void app.close();
    });
  }
}
