import { OpenAPIRegistry, OpenApiGeneratorV31, extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

extendZodWithOpenApi(z);

// Every route registers its request/response schemas here, so the frontend can
// generate a typed client from /openapi.json instead of copying types by hand.
export const registry = new OpenAPIRegistry();

export const HealthResponse = registry.register(
  "HealthResponse",
  z.object({
    status: z.literal("ok"),
    service: z.literal("setu-retail-be"),
    version: z.string(),
    time: z.iso.datetime(),
  }),
);

export const ErrorResponse = registry.register(
  "ErrorResponse",
  z.object({
    error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
  }),
);

registry.registerPath({
  method: "get",
  path: "/health",
  summary: "Liveness check",
  responses: { 200: { description: "API is up", content: { "application/json": { schema: HealthResponse } } } },
});

registry.registerPath({
  method: "get",
  path: "/health/db",
  summary: "Database connectivity check",
  responses: {
    200: { description: "Database reachable", content: { "application/json": { schema: z.object({ status: z.literal("ok") }) } } },
    503: { description: "Database unreachable", content: { "application/json": { schema: ErrorResponse } } },
  },
});

export function buildOpenApiDocument(version: string) {
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: "3.1.0",
    info: { title: "Setu Retail API", version },
    servers: [{ url: "https://api.retail-pos.setutechnology.com" }],
  });
}
