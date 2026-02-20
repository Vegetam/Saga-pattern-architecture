import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { SagaEntity, SagaStatus } from './entities/saga.entity';

@Injectable()
export class SagaRepository {
  private readonly logger = new Logger(SagaRepository.name);

  constructor(
    @InjectRepository(SagaEntity)
    private readonly repo: Repository<SagaEntity>,
    private readonly dataSource: DataSource,
  ) {}

  async save(saga: SagaEntity): Promise<SagaEntity> {
    return this.repo.save(saga);
  }

  async findById(sagaId: string): Promise<SagaEntity | null> {
    return this.repo.findOne({ where: { id: sagaId } });
  }

  async findByIdOrThrow(sagaId: string): Promise<SagaEntity> {
    const saga = await this.findById(sagaId);
    if (!saga) {
      throw new Error(`Saga not found: ${sagaId}`);
    }
    return saga;
  }

  async updateStatus(sagaId: string, status: SagaStatus): Promise<void> {
    await this.repo.update({ id: sagaId }, { status });
  }

  async updateStepResults(
    sagaId: string,
    stepResults: Record<string, unknown>,
  ): Promise<void> {
    await this.repo.update({ id: sagaId }, { stepResults });
  }

  async markCompleted(
    sagaId: string,
    stepResults: Record<string, unknown>,
  ): Promise<void> {
    await this.repo.update(
      { id: sagaId },
      {
        status: SagaStatus.COMPLETED,
        stepResults,
        completedAt: new Date(),
      },
    );
  }

  async markFailed(sagaId: string): Promise<void> {
    await this.repo.update(
      { id: sagaId },
      { status: SagaStatus.FAILED, completedAt: new Date() },
    );
  }

  async markCompensationFailed(sagaId: string): Promise<void> {
    await this.repo.update(
      { id: sagaId },
      { status: SagaStatus.COMPENSATION_FAILED },
    );
  }

  async markCompensating(sagaId: string): Promise<void> {
    await this.repo.update(
      { id: sagaId },
      { status: SagaStatus.COMPENSATING },
    );
  }

  async findTimedOutSagas(): Promise<SagaEntity[]> {
    return this.repo
      .createQueryBuilder('saga')
      .where('saga.timeoutAt < :now', { now: new Date() })
      .andWhere('saga.status NOT IN (:...terminalStatuses)', {
        terminalStatuses: [
          SagaStatus.COMPLETED,
          SagaStatus.FAILED,
          SagaStatus.COMPENSATION_FAILED,
        ],
      })
      .getMany();
  }

  async findByStatus(status: SagaStatus): Promise<SagaEntity[]> {
    return this.repo.find({ where: { status } });
  }

  /**
   * Stats for monitoring dashboard / Prometheus metrics
   */
  async getStats(): Promise<Record<string, number>> {
    const results = await this.repo
      .createQueryBuilder('saga')
      .select('saga.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('saga.status')
      .getRawMany<{ status: string; count: string }>();

    return Object.fromEntries(
      results.map((r: { status: string; count: string }) => [r.status, parseInt(r.count, 10)]),
    );
  }
}
