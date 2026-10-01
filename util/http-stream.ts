/** Keep a resource leased until the response is consumed, fails, or is cancelled. */
export function holdResponse(response: Response, release: () => void | Promise<void>, signal?: AbortSignal): Response {
  let released = false;
  const done = async () => {
    if (!released) { released = true; signal?.removeEventListener('abort', abort); await release(); }
  };
  const abort = () => { void reader?.cancel(signal?.reason).catch(() => {}).finally(done); };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  if (!response.body) { void done(); return response; }
  reader = response.body.getReader();
  const source = reader;
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await source.read();
        if (next.done) { await done(); controller.close(); }
        else controller.enqueue(next.value);
      } catch (error) { controller.error(error); await done(); }
    },
    async cancel(reason) { try { await source.cancel(reason); } finally { await done(); } },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
