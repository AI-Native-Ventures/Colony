/** A real byte-range response for media fixtures served through Playwright routes. */
export function mediaFixtureRange(bytes: Buffer, range: string | undefined) {
  const headers: Record<string, string> = {
    "accept-ranges": "bytes",
    "content-length": String(bytes.length),
  };
  if (!range) return { status: 200, headers, body: bytes };
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  const start = match?.[1]
    ? Number(match[1])
    : Math.max(0, bytes.length - Number(match?.[2]));
  const end =
    match?.[1] && match[2]
      ? Math.min(Number(match[2]), bytes.length - 1)
      : bytes.length - 1;
  if (
    !match ||
    (!match[1] && !match[2]) ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= bytes.length ||
    end < start
  ) {
    return {
      status: 416,
      headers: {
        ...headers,
        "content-range": `bytes */${bytes.length}`,
        "content-length": "0",
      },
      body: Buffer.alloc(0),
    };
  }
  const body = bytes.subarray(start, end + 1);
  return {
    status: 206,
    headers: {
      ...headers,
      "content-range": `bytes ${start}-${end}/${bytes.length}`,
      "content-length": String(body.length),
    },
    body,
  };
}
