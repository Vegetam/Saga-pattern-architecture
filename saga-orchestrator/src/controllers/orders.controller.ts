import { Body, Controller, Post } from '@nestjs/common';

import { SagaOrchestrator } from '../SagaOrchestrator';
import { orderSagaDefinition } from '../sagas/order.saga';

type OrderItem = { productId: string; qty: number; unitPrice: number };

interface CreateOrderRequest {
  customerId: string;
  items: OrderItem[];
  paymentMethod?: string;
  currency?: string;
}

@Controller('api/orders')
export class OrdersController {
  constructor(private readonly orchestrator: SagaOrchestrator) {}

  @Post()
  async createOrder(@Body() body: CreateOrderRequest): Promise<{ sagaId: string }> {
    const payload = {
      customerId: body.customerId,
      items: body.items,
      paymentMethod: body.paymentMethod ?? 'card_demo',
      currency: body.currency ?? 'USD',
    };

    const sagaId = await this.orchestrator.startSaga(orderSagaDefinition, payload);
    return { sagaId };
  }
}
