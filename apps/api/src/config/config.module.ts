import { Global, Module } from '@nestjs/common';

import { type ApiConfig, loadConfig } from './config';

/**
 * The one place the environment is read, published as a token.
 *
 * `@Global` so every module can inject `API_CONFIG` without re-importing this
 * one. A value provider rather than a class: the config is a plain frozen object
 * with no behaviour, and making it a service would invite methods that read the
 * environment again at call time.
 */
export const API_CONFIG = Symbol('API_CONFIG');

@Global()
@Module({
  providers: [{ provide: API_CONFIG, useFactory: (): ApiConfig => loadConfig() }],
  exports: [API_CONFIG],
})
export class ConfigModule {}
