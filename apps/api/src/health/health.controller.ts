import type { Health } from '@kan/shared';
import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { NoRate } from '../common/rate-limit';
import { Public } from '../common/public.decorator';
import { HealthService } from './health.service';

@Controller('health')
@Public()
@NoRate()
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  /**
   * `200` when every dependency answered, `503` when one did not.
   *
   * The status code is the part a monitor reads, and it has to disagree with the
   * process being alive. An endpoint that answers 200 with `"status":"degraded"`
   * in the body is an endpoint whose alert nobody has configured, because the
   * default configuration of every uptime checker on earth is "is it 2xx".
   *
   * `passthrough: true` keeps Nest's serialisation: the returned object is still
   * the body, so the response parses against `healthSchema` either way. Throwing
   * a `ServiceUnavailableException` would work too and would bury the health
   * payload under the exception filter's `{statusCode, message}` envelope.
   */
  @Get()
  async get(@Res({ passthrough: true }) response: Response): Promise<Health> {
    const health = await this.health.check();
    response.status(health.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return health;
  }
}
