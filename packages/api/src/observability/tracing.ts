import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';

/**
 * Distributed tracing over OTLP/HTTP, enabled only when OTEL_EXPORTER_OTLP_ENDPOINT is set (the
 * exporter reads the standard OTEL_* variables). Traces HTTP in/out (including provider calls),
 * Express routes, PostgreSQL, and Redis/BullMQ commands. Must start before those modules are used.
 */
export function startTracing(serviceName: string): NodeSDK | undefined {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return undefined;
  process.env.OTEL_SERVICE_NAME ??= serviceName;
  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      new HttpInstrumentation(),
      new ExpressInstrumentation(),
      new PgInstrumentation({ enhancedDatabaseReporting: false }), // never record query parameters (PII)
      new IORedisInstrumentation(),
    ],
  });
  sdk.start();
  return sdk;
}
