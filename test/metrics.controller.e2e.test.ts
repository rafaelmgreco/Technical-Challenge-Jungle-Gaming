import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { MetricsController } from '../src/metrics/metrics.controller.js';
import { MetricsRegistry } from '../src/infrastructure/metrics/metrics.registry.js';

describe('MetricsController (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [MetricsController],
      providers: [MetricsRegistry],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('exposes metrics in Prometheus text format', async () => {
    const response = await request(app.getHttpServer())
      .get('/metrics')
      .expect(200);

    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.text).toContain(
      'wager_transaction_submissions_total{source="http",status="PROCESSED"} 0',
    );
    expect(response.text).toContain(
      'wager_processing_duration_seconds_count 0',
    );
  });
});
