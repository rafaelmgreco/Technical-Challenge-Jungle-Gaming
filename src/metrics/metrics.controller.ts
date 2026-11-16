import { Controller, Get, Header } from '@nestjs/common';
import {
  MetricsRegistry,
  PROMETHEUS_CONTENT_TYPE,
} from '../infrastructure/metrics/metrics.registry.js';

@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsRegistry) {}

  @Get('metrics')
  @Header('Content-Type', PROMETHEUS_CONTENT_TYPE)
  render(): string {
    return this.metrics.renderPrometheus();
  }
}
