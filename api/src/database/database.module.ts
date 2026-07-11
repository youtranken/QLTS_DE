import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

export const PG_POOL = 'PG_POOL';
export const DRIZZLE_DB = 'DRIZZLE_DB';

// Khớp KIỂU THỰC drizzle(pool) trả về ở phiên bản hiện tại (schema param `Record<string,unknown>`,
// kèm `$client`). Bare `NodePgDatabase` default về `Record<string,never>` → db-spec truyền
// `drizzle(pool)` vào service báo lệch kiểu (hygiene). Dùng schemaless (select/insert(table)/execute)
// nên schema param không ảnh hưởng runtime.
export type Database = NodePgDatabase<Record<string, unknown>>;

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: (): Pool => {
        const pool = new Pool({ connectionString: process.env.DATABASE_URL });
        // pg Pool emit 'error' khi client idle rớt kết nối (Postgres restart/OOM);
        // không có listener → uncaught exception giết cả process.
        pool.on('error', (error) => {
          console.error('[pg-pool] lỗi kết nối idle:', error);
        });
        return pool;
      },
    },
    {
      provide: DRIZZLE_DB,
      useFactory: (pool: Pool): Database => drizzle(pool),
      inject: [PG_POOL],
    },
  ],
  exports: [PG_POOL, DRIZZLE_DB],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
