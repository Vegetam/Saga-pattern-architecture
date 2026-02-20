import { SagaDefinition } from '../SagaOrchestrator';

export const orderSagaDefinition: SagaDefinition = {
  name: 'OrderSaga',
  steps: [
    {
      name: 'Reserve Order',
      command: 'RESERVE_ORDER',
      topic: 'saga-order-commands',
      compensationCommand: 'CANCEL_ORDER',
      compensationTopic: 'saga-order-commands',
      timeoutMs: 30_000,
    },
    {
      name: 'Process Payment',
      command: 'PROCESS_PAYMENT',
      topic: 'saga-payment-commands',
      compensationCommand: 'REFUND_PAYMENT',
      compensationTopic: 'saga-payment-commands',
      timeoutMs: 30_000,
    },
    {
      name: 'Reserve Inventory',
      command: 'RESERVE_INVENTORY',
      topic: 'saga-inventory-commands',
      compensationCommand: 'RELEASE_INVENTORY',
      compensationTopic: 'saga-inventory-commands',
      timeoutMs: 30_000,
    },
  ],
  timeoutMs: 120_000,
};
