import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  createDatabaseConnectionProvider,
  PrismaClient,
  type DatabaseConnectionProvider,
} from '@hardware-pos/database';

/**
 * Thin NestJS wrapper around the generated Prisma client. Repositories inject
 * this and use it as the single gateway to the database (controller → service →
 * repository → PrismaService).
 *
 * WHICH database (and how it is reached) is decided by the connection provider
 * resolved from `DB_PROVIDER`/`DATABASE_URL` — see @hardware-pos/database.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private static readonly logger = new Logger(PrismaService.name);
  private readonly connection: DatabaseConnectionProvider;

  constructor() {
    const connection = createDatabaseConnectionProvider(process.env);
    super(connection.clientOptions());
    this.connection = connection;
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    PrismaService.logger.log(`Connected to database (provider: ${this.connection.kind})`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    await this.connection.dispose();
  }
}
