import {
  Entity,
  Column,
  PrimaryColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum SagaStatus {
  STARTED = 'STARTED',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  COMPENSATING = 'COMPENSATING',
  COMPENSATION_FAILED = 'COMPENSATION_FAILED',
  FAILED = 'FAILED',
}

export enum SagaStepStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  COMPENSATING = 'COMPENSATING',
  COMPENSATED = 'COMPENSATED',
}

export interface SagaStepRecord {
  index: number;
  name: string;
  status: SagaStepStatus;
}

@Entity('sagas')
export class SagaEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column()
  name!: string;

  // Use varchar instead of postgres ENUM to keep deployments/migrations simpler
  @Column({ type: 'varchar', length: 50, default: SagaStatus.STARTED })
  status!: SagaStatus;

  @Column({ type: 'jsonb' })
  payload!: object;

  @Column({ type: 'jsonb', default: {} })
  stepResults!: object;

  @Column({ type: 'jsonb', default: [] })
  steps!: SagaStepRecord[];

  @Column({ default: 0 })
  currentStepIndex!: number;

  @Column({ type: 'timestamptz', nullable: true })
  timeoutAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
