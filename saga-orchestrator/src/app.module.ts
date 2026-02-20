import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SagaEntity } from './entities/saga.entity';

import { KafkaService } from './kafka/kafka.service';
import { RedisService } from './redis/redis.service';

import { SagaRepository } from './SagaRepository';
import { StepExecutor } from './StepExecutor';
import { CompensationManager } from './CompensationManager';
import { SagaStateMachine } from './SagaStateMachine';
import { SagaOrchestrator } from './SagaOrchestrator';

import { MetricsService } from './metrics/metrics.service';

import { ProbesController } from './controllers/probes.controller';
import { OrdersController } from './controllers/orders.controller';
import { SagasController } from './controllers/sagas.controller';
import { MetricsController } from './controllers/metrics.controller';

import { SagaBootstrapService } from './saga-bootstrap.service';
import { DbInitService } from './db-init.service';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      url:
        process.env.DATABASE_URL ||
        'postgresql://saga_user:saga_pass@localhost:5432/saga_db',
      entities: [SagaEntity],
      synchronize:
        typeof process.env.TYPEORM_SYNCHRONIZE === 'string'
          ? process.env.TYPEORM_SYNCHRONIZE === 'true'
          : process.env.NODE_ENV !== 'production',
      migrationsRun: process.env.TYPEORM_MIGRATIONS_RUN === 'true',
      logging: process.env.TYPEORM_LOGGING === 'true',
    }),
    TypeOrmModule.forFeature([SagaEntity]),
  ],
  controllers: [ProbesController, OrdersController, SagasController, MetricsController],
  providers: [
    KafkaService,
    RedisService,
    DbInitService,
    SagaRepository,
    StepExecutor,
    CompensationManager,
    SagaStateMachine,
    SagaOrchestrator,
    SagaBootstrapService,
    MetricsService,
  ],
})
export class AppModule {}
