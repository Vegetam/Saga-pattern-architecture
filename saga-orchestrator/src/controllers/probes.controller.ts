import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { KafkaService } from '../kafka/kafka.service';
import { RedisService } from '../redis/redis.service';

@Controller()
export class ProbesController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly kafka: KafkaService,
    private readonly redis: RedisService,
  ) {}

  @Get('/live')
  live(): Record<string, string> {
    return { status: 'ok', service: 'saga-orchestrator' };
  }

  @Get('/ready')
  async ready(): Promise<Record<string, unknown>> {
    const checks: Record<string, boolean> = {
      db: false,
      kafka: false,
      redis: false,
    };

    try {
      await this.dataSource.query('SELECT 1');
      checks.db = true;
    } catch {
      checks.db = false;
    }

    // Require producer + reply subscription
    checks.kafka = this.kafka.isReady(['saga-replies']);
    checks.redis = await this.redis.ping();

    const ok = Object.values(checks).every(Boolean);
    if (!ok) {
      throw new ServiceUnavailableException({
        status: 'not-ready',
        service: 'saga-orchestrator',
        checks,
      });
    }

    return { status: 'ok', service: 'saga-orchestrator', checks };
  }

  // Backwards compatible alias
  @Get('/health')
  async health(): Promise<Record<string, unknown>> {
    return this.ready();
  }
}
