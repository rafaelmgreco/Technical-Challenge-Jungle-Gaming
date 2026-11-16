import { Controller, Get } from '@nestjs/common';
import { HealthCheckService } from '../infrastructure/health/health-check.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly healthChecks: HealthCheckService) {}

  @Get('live')
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  readiness(): Promise<{
    status: 'ok';
    checks: { database: 'ok'; sqs: 'ok' };
  }> {
    return this.healthChecks.readiness();
  }
}
