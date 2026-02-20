import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class DbInitService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DbInitService.name);

  constructor(private readonly dataSource: DataSource) {}

  async onApplicationBootstrap(): Promise<void> {
    // Idempotent bootstrap for environments where TypeORM synchronize is disabled.
    // Safe to run even when synchronize is enabled.
    try {
      await this.dataSource.query(`
        CREATE EXTENSION IF NOT EXISTS pgcrypto;
        CREATE TABLE IF NOT EXISTS sagas (
          id UUID PRIMARY KEY,
          name TEXT NOT NULL,
          status VARCHAR(50) NOT NULL DEFAULT 'STARTED',
          payload JSONB NOT NULL,
          "stepResults" JSONB NOT NULL DEFAULT '{}'::jsonb,
          steps JSONB NOT NULL DEFAULT '[]'::jsonb,
          "currentStepIndex" INT NOT NULL DEFAULT 0,
          "timeoutAt" TIMESTAMPTZ NULL,
          "completedAt" TIMESTAMPTZ NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_sagas_status ON sagas(status);

        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at'
          ) THEN
            CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
            BEGIN
              NEW."updatedAt" = NOW();
              RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
          END IF;
        END $$;

        DROP TRIGGER IF EXISTS set_updated_at_sagas ON sagas;
        CREATE TRIGGER set_updated_at_sagas
          BEFORE UPDATE ON sagas
          FOR EACH ROW
          EXECUTE PROCEDURE set_updated_at();
      `);
      this.logger.log('DB bootstrap completed');
    } catch (err) {
      this.logger.error('DB bootstrap failed', err as Error);
      // Let the app fail fast; readiness will also reflect failure.
      throw err;
    }
  }
}
