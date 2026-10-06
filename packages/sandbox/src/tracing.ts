import { context, propagation, SpanStatusCode, trace, type Attributes } from '@opentelemetry/api';

/** Optional instrumentation: without a registered provider these are no-op spans. */
export function traced<T>(name: string, attributes: Attributes, action: () => Promise<T>): Promise<T> {
  return trace.getTracer('co-cell.sandbox').startActiveSpan(name, { attributes }, async span => {
    try { return await action(); }
    catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.setAttribute('error.type', error instanceof Error ? error.name : 'Error');
      throw error;
    } finally { span.end(); }
  });
}

export function traceEvent(name: string, attributes?: Attributes): void {
  trace.getActiveSpan()?.addEvent(name, attributes);
}

export function injectTraceHeaders(headers: Record<string, string>): void {
  propagation.inject(context.active(), headers);
}
