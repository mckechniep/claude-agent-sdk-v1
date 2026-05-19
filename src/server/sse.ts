import type { IncomingMessage, ServerResponse } from "node:http";

export interface SseStream {
  send: (event: string, data: unknown) => void;
  comment: (text: string) => void;
  close: () => void;
  closed: () => boolean;
  onClientClose: (handler: () => void) => void;
}

export function openSseStream(req: IncomingMessage, res: ServerResponse): SseStream {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  let isClosed = false;
  const closeHandlers = new Set<() => void>();

  const markClosed = (): void => {
    if (isClosed) return;
    isClosed = true;
    for (const handler of closeHandlers) handler();
  };

  req.on("close", markClosed);
  res.on("close", markClosed);

  return {
    send(event, data) {
      if (isClosed || res.writableEnded) return;
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    },
    comment(text) {
      if (isClosed || res.writableEnded) return;
      res.write(`: ${text}\n\n`);
    },
    close() {
      if (isClosed || res.writableEnded) return;
      res.end();
      markClosed();
    },
    closed() {
      return isClosed;
    },
    onClientClose(handler) {
      if (isClosed) handler();
      else closeHandlers.add(handler);
    },
  };
}
