import { Controller, Get, Post, Body, Param, ParseUUIDPipe, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { SagaOrchestrator, SagaDefinition } from './SagaOrchestrator';
import { SagaEntity } from './entities/saga.entity';

@ApiTags('Sagas')
@Controller('sagas')
export class SagaController {
  constructor(private readonly orchestrator: SagaOrchestrator) {}

  @Post('order')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Start a new order saga' })
  async startOrderSaga(
    @Body() body: { customerId: string; items: unknown[]; paymentMethod: string },
  ): Promise<{ sagaId: string }> {
    const definition: SagaDefinition = {
      name: 'CreateOrderSaga',
      steps: [
        { name: 'ReserveOrder', command: 'RESERVE_ORDER', topic: 'saga-order-commands',
          compensationCommand: 'CANCEL_ORDER', compensationTopic: 'saga-order-commands', timeoutMs: 30000 },
        { name: 'ProcessPayment', command: 'PROCESS_PAYMENT', topic: 'saga-payment-commands',
          compensationCommand: 'REFUND_PAYMENT', compensationTopic: 'saga-payment-commands', timeoutMs: 60000 },
        { name: 'ReserveInventory', command: 'RESERVE_INVENTORY', topic: 'saga-inventory-commands',
          compensationCommand: 'RELEASE_INVENTORY', compensationTopic: 'saga-inventory-commands', timeoutMs: 30000 },
        { name: 'SendNotification', command: 'SEND_NOTIFICATION', topic: 'saga-notification-commands',
          timeoutMs: 15000 },
      ],
      timeoutMs: 300000,
    };

    const sagaId = await this.orchestrator.startSaga(definition, { ...body });
    return { sagaId };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get saga status by ID' })
  async getSaga(@Param('id', ParseUUIDPipe) id: string): Promise<SagaEntity | null> {
    return this.orchestrator.getSagaStatus(id);
  }

  @Get()
  @ApiOperation({ summary: 'Get saga metrics' })
  async getStats(): Promise<Record<string, number>> {
    return this.orchestrator.getSagaStats();
  }
}
