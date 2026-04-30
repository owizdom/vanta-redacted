/**
 * Fastify app factory. Routes are mounted by the caller (`main.ts` or
 * tests via `app.inject(...)`).
 *
 * We use `fastify-type-provider-zod` so the same zod schemas that
 * validate event bodies inside the runtime also validate request
 * bodies at the HTTP edge — one source of truth, no DTO drift.
 */

import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";

import type { Bootstrap } from "../bootstrap.js";
import type { RuntimeConfig } from "../config.js";

export interface AppDeps {
  readonly config: RuntimeConfig;
  readonly bootstrap: Bootstrap;
}

export type App = FastifyInstance & { readonly typeProvider?: ZodTypeProvider };

export function createApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: false,
    bodyLimit: 256 * 1024,
    trustProxy: false,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Decorate so route modules can reach into deps without a
  // module-global singleton.
  app.decorate("config", deps.config);
  app.decorate("bootstrap", deps.bootstrap);

  return app;
}

declare module "fastify" {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface FastifyInstance {
    config: RuntimeConfig;
    bootstrap: Bootstrap;
  }
}
