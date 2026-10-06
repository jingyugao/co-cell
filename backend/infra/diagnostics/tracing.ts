import { context, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { MiddlewareHandler } from 'hono';

/** Export only traces. Export failure never blocks an application operation. */
export function initializeTracing(): (() => Promise<void>) | undefined {
  if (process.env.OTEL_SDK_DISABLED === 'true' ||
      !(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT)) return;
  const protocol = process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? process.env.OTEL_EXPORTER_OTLP_PROTOCOL;
  if (protocol && protocol !== 'http/protobuf') throw new Error('Tracing requires OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf');
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': process.env.OTEL_SERVICE_NAME || 'co-cell' }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter(), {
      scheduledDelayMillis: 1000, exportTimeoutMillis: 5000, maxQueueSize: 4096,
    })],
  });
  provider.register();
  return () => provider.shutdown();
}

export const traceHttpRequest: MiddlewareHandler = async (c, next) => {
  const parent = propagation.extract(context.active(), Object.fromEntries(c.req.raw.headers));
  return context.with(parent, () => trace.getTracer('co-cell.http').startActiveSpan('http.request', {
    kind: SpanKind.SERVER,
    attributes: { 'http.request.method': c.req.method, 'url.path': c.req.path },
  }, async span => {
    try {
      await next();
      span.setAttribute('http.response.status_code', c.res.status);
      if (c.res.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      const traceId = span.spanContext().traceId;
      if (traceId !== '00000000000000000000000000000000') c.header('X-Trace-Id', traceId);
      span.addEvent('http.response.ready');
    } finally { span.end(); }
  }));
};
