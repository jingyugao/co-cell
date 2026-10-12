import { context, createContextKey, propagation, SpanKind, SpanStatusCode, trace, type Context, type Span } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { MiddlewareHandler } from 'hono';

const projectRequestTraceKey = createContextKey('co-cell.project-request-trace');

type ProjectRequestTrace = {
  context: Context;
  span: Span;
  references: number;
  httpFinished: boolean;
  ended: boolean;
};

/** Retain the project request root until the admitted lifecycle work completes. */
export function retainProjectRequestTrace(): { context: Context; release(error?: unknown): void } | undefined {
  const lifecycle = context.active().getValue(projectRequestTraceKey) as ProjectRequestTrace | undefined;
  if (!lifecycle || lifecycle.ended) return;
  lifecycle.references++;
  let released = false;
  return {
    context: lifecycle.context,
    release(error?: unknown) {
      if (released) return;
      released = true;
      if (error !== undefined) {
        lifecycle.span.setStatus({ code: SpanStatusCode.ERROR });
        lifecycle.span.setAttribute('error.type', error instanceof Error ? error.name : 'Error');
      }
      lifecycle.references--;
      endProjectRequestTraceIfComplete(lifecycle);
    },
  };
}

function endProjectRequestTraceIfComplete(lifecycle: ProjectRequestTrace) {
  if (lifecycle.ended || !lifecycle.httpFinished || lifecycle.references > 0) return;
  lifecycle.ended = true;
  lifecycle.span.end();
}

function isProjectLifecycleRequest(method: string, path: string) {
  return method === 'POST' && /^\/api\/projects\/[^/]+\/(?:open|sandbox\/resume)$/.test(path);
}

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
  return context.with(parent, async () => {
    const tracer = trace.getTracer('co-cell.http');
    const attributes = { 'http.request.method': c.req.method, 'url.path': c.req.path };
    if (!isProjectLifecycleRequest(c.req.method, c.req.path)) {
      return tracer.startActiveSpan('http.request', { kind: SpanKind.SERVER, attributes }, async span => {
        try {
          await next();
          span.setAttribute('http.response.status_code', c.res.status);
          if (c.res.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
          const traceId = span.spanContext().traceId;
          if (traceId !== '00000000000000000000000000000000') c.header('X-Trace-Id', traceId);
          span.addEvent('http.response.ready');
        } finally { span.end(); }
      });
    }

    return tracer.startActiveSpan('project.request', { kind: SpanKind.INTERNAL, attributes }, async projectSpan => {
      const lifecycle: ProjectRequestTrace = {
        context: context.active(), span: projectSpan, references: 1, httpFinished: false, ended: false,
      };
      const lifecycleContext = lifecycle.context.setValue(projectRequestTraceKey, lifecycle);
      return context.with(lifecycleContext, () => tracer.startActiveSpan('http.request', {
        kind: SpanKind.SERVER, attributes,
      }, async httpSpan => {
        try {
          await next();
          httpSpan.setAttribute('http.response.status_code', c.res.status);
          if (c.res.status >= 500) {
            httpSpan.setStatus({ code: SpanStatusCode.ERROR });
            projectSpan.setStatus({ code: SpanStatusCode.ERROR });
          }
          const traceId = projectSpan.spanContext().traceId;
          if (traceId !== '00000000000000000000000000000000') c.header('X-Trace-Id', traceId);
          httpSpan.addEvent('http.response.ready');
        } catch (error) {
          httpSpan.setStatus({ code: SpanStatusCode.ERROR });
          httpSpan.setAttribute('error.type', error instanceof Error ? error.name : 'Error');
          projectSpan.setStatus({ code: SpanStatusCode.ERROR });
          projectSpan.setAttribute('error.type', error instanceof Error ? error.name : 'Error');
          throw error;
        } finally {
          httpSpan.end();
          lifecycle.httpFinished = true;
          lifecycle.references--;
          endProjectRequestTraceIfComplete(lifecycle);
        }
      }));
    });
  });
};
