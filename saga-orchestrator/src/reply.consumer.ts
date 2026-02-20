import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { KafkaService } from './kafka/kafka.service';
import { SagaOrchestrator, StepReply } from './SagaOrchestrator';

/**
 * Listens on saga-replies and saga-compensation-replies topics
 * and feeds messages back into the SagaOrchestrator.
 */
@Injectable()
export class ReplyConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReplyConsumer.name);

  constructor(
    private readonly kafkaService: KafkaService,
    private readonly orchestrator: SagaOrchestrator,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.kafkaService.subscribe(
      'saga-replies',
      'saga-orchestrator-replies',
      async (payload) => {
        this.logger.debug(`Reply received: sagaId=${payload.sagaId as string}, step=${payload.stepIndex as number}, success=${payload.success as boolean}`);
        await this.orchestrator.handleStepReply(payload as unknown as StepReply);
      },
    );

    await this.kafkaService.subscribe(
      'saga-compensation-replies',
      'saga-orchestrator-comp-replies',
      async (payload) => {
        this.logger.debug(`Compensation reply: sagaId=${payload.sagaId as string}, step=${payload.stepIndex as number}`);
        await this.orchestrator.handleStepReply(payload as unknown as StepReply);
      },
    );

    this.logger.log('Saga reply consumers started on [saga-replies, saga-compensation-replies]');
  }
}
