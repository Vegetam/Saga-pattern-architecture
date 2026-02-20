import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';

type Mode = 'redis' | 'memory';

@Injectable()
export class RedisService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis | null = null;
  private readonly mode: Mode = ((process.env.SAGA_STATE_STORE || process.env.REDIS_MODE || 'memory') as Mode);

  // In-memory fallback (PoC-friendly; single-process only)
  private locks = new Map<string, number>(); // key -> expiresAt (ms)
  private kv = new Map<string, { value: string; expiresAt: number | null }>();

  onApplicationBootstrap(): void {
    if (this.mode === 'memory') {
      this.logger.log('Using in-memory saga state store (SAGA_STATE_STORE=memory)');
      return;
    }

    const url = process.env.REDIS_URL;
    this.client = url
      ? new Redis(url)
      : new Redis({
          host: process.env.REDIS_HOST || 'localhost',
          port: parseInt(process.env.REDIS_PORT || '6379', 10),
          password: process.env.REDIS_PASSWORD || undefined,
          retryStrategy: (times: number) => Math.min(times * 100, 3000),
        });

    this.client.on('connect', () => this.logger.log('Redis connected'));
    this.client.on('error', (err: unknown) => this.logger.error('Redis error', err));
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.logger.log('Redis disconnected');
    }
  }

  // ───────────────────────────────────────────────────────────────
  // Locks
  // ───────────────────────────────────────────────────────────────

  /**
   * Acquire a distributed lock via SET NX PX (atomic Redis operation).
   * Returns true if the lock was acquired, false if already held.
   */
  async acquireLock(key: string, ttlMs: number): Promise<boolean> {
    if (this.mode === 'memory') {
      const now = Date.now();
      const k = `lock:${key}`;
      const expiresAt = this.locks.get(k) ?? 0;
      if (expiresAt > now) return false;
      this.locks.set(k, now + ttlMs);
      return true;
    }

    if (!this.client) throw new Error('Redis client not initialized');
    const result = await this.client.set(`lock:${key}`, '1', 'PX', ttlMs, 'NX');
    return result === 'OK';
  }

  /** Release a distributed lock. */
  async releaseLock(key: string): Promise<void> {
    if (this.mode === 'memory') {
      this.locks.delete(`lock:${key}`);
      return;
    }
    if (!this.client) throw new Error('Redis client not initialized');
    await this.client.del(`lock:${key}`);
  }

  // ───────────────────────────────────────────────────────────────
  // Key/value + TTL
  // ───────────────────────────────────────────────────────────────

  /** Store a value with a TTL (in seconds). */
  async setWithTtl(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (this.mode === 'memory') {
      this.kv.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
      return;
    }
    if (!this.client) throw new Error('Redis client not initialized');
    await this.client.set(key, value, 'EX', ttlSeconds);
  }

  /** Get a value by key. */
  async get(key: string): Promise<string | null> {
    if (this.mode === 'memory') {
      const entry = this.kv.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
        this.kv.delete(key);
        return null;
      }
      return entry.value;
    }
    if (!this.client) throw new Error('Redis client not initialized');
    return this.client.get(key);
  }

  /** Delete a key. */
  async del(key: string): Promise<void> {
    if (this.mode === 'memory') {
      this.kv.delete(key);
      return;
    }
    if (!this.client) throw new Error('Redis client not initialized');
    await this.client.del(key);
  }

  /** Check if a key exists. */
  async exists(key: string): Promise<boolean> {
    if (this.mode === 'memory') {
      return (await this.get(key)) !== null;
    }
    if (!this.client) throw new Error('Redis client not initialized');
    const result = await this.client.exists(key);
    return result === 1;
  }

  /** Readiness check */
  async ping(): Promise<boolean> {
    if (this.mode === 'memory') return true;
    if (!this.client) return false;
    try {
      const res = await this.client.ping();
      return res === 'PONG';
    } catch {
      return false;
    }
  }
}
