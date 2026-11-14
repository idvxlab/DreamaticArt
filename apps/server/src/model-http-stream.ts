export function observeModelHttpStream() {
  let status: number | undefined;
  let requestId: string | undefined;
  let lastChunkAt: number | undefined;
  let request = 0;

  const reset = () => {
    status = requestId = lastChunkAt = undefined;
    return ++request;
  };
  const fetchWithDiagnostics: typeof fetch = async (input, init) => {
    const current = reset();
    const response = await fetch(input, init);
    if (current !== request) return response;
    status = response.status;
    const id = response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? response.headers.get('x-dashscope-request-id');
    if (id && /^[\w.:-]{1,160}$/.test(id)) requestId = id;
    if (!response.ok || !response.body) return response;

    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (current === request && chunk.byteLength) lastChunkAt = Date.now();
        controller.enqueue(chunk);
      },
    }));
    return new Response(body, response);
  };
  return {
    fetch: fetchWithDiagnostics,
    reset,
    describe: () => [
      ...(status === undefined ? [] : [`HTTP status: ${status}`]),
      ...(requestId ? [`Provider request ID: ${requestId}`] : []),
      `Last HTTP stream chunk: ${lastChunkAt === undefined ? 'none observed' : new Date(lastChunkAt).toISOString()}`,
    ],
  };
}
