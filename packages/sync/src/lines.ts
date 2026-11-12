/** Splits a byte stream into lines as chunks arrive, so the snapshot is applied batch by batch while it downloads. */
export async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let tail = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    // stream: a multi-byte character split between chunks is held back until its rest arrives.
    const value = decoder.decode(chunk.value, { stream: true });
    // A batch line spans many chunks: look for the newline in the new chunk only, not in the whole tail again.
    const first = value.indexOf("\n");
    if (first < 0) {
      tail += value;
      continue;
    }
    const text = tail + value;
    let from = 0;
    for (let nl = tail.length + first; nl >= 0; nl = text.indexOf("\n", from)) {
      if (nl > from) yield text.slice(from, nl);
      from = nl + 1;
    }
    tail = text.slice(from);
  }
  tail += decoder.decode();
  if (tail) yield tail;
}
