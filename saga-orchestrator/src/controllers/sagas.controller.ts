import { Controller, Get, Param } from '@nestjs/common';

import { SagaRepository } from '../SagaRepository';

@Controller('api/sagas')
export class SagasController {
  constructor(private readonly repo: SagaRepository) {}

  @Get(':id')
  async getSaga(@Param('id') id: string): Promise<unknown> {
    const saga = await this.repo.findById(id);
    return saga ?? { error: 'not_found', sagaId: id };
  }

  @Get()
  async stats(): Promise<Record<string, number>> {
    return this.repo.getStats();
  }
}
