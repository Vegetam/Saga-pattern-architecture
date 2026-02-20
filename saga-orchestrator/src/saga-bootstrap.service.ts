import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { z } from 'zod';

import { KafkaService } from './kafka/kafka.service';
import { SagaOrchestrator, StepReply } from './SagaOrchestrator';
import { orderSagaDefinition } from './sagas/order.saga';

const StepReplySchema = z.object({
  sagaId: z.string().min(1),
  stepIndex: z.number().int().nonnegative(),
  success: z.boolean(),
  result: z.record(z.any()).optional(),
  error: z.string().optional(),
  correlationId: z.string().optional().default(''),
});

@Injectable()
export class SagaBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SagaBootstrapService.name);

  constructor(
    private readonly kafka: KafkaService,
    private readonly orchestrator: SagaOrchestrator,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Register saga definitions
    this.orchestrator.registerDefinition(orderSagaDefinition);

    // Subscribe to replies
    await this.kafka.subscribe('saga-replies', 'saga-orchestrator-replies', async (msg) => {
      const reply = StepReplySchema.parse(msg) as unknown as StepReply;
      await this.orchestrator.handleStepReply(reply);
    });

    this.logger.log('Saga bootstrap complete');
  }
}
