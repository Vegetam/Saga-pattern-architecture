import { Injectable } from '@nestjs/common';
import * as client from 'prom-client';

@Injectable()
export class MetricsService {
  private readonly registry = client.register;

  readonly sagaStarted = new client.Counter({
    name: 'saga_started_total',
    help: 'Total number of sagas started',
    labelNames: ['sagaName'],
  });

  readonly sagaCompleted = new client.Counter({
    name: 'saga_completed_total',
    help: 'Total number of sagas completed',
    labelNames: ['sagaName'],
  });

  readonly sagaFailed = new client.Counter({
    name: 'saga_failed_total',
    help: 'Total number of sagas failed',
    labelNames: ['sagaName'],
  });

  constructor() {
    // Default Node.js metrics (CPU, memory, event loop, GC, etc.)
    client.collectDefaultMetrics({ register: this.registry });
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }
}
