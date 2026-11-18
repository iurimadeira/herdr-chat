// A client of the chat's records: a TCP or Unix socket (JSONL) or a WebSocket with an ack window.
// The host serves them; the relay (relay.ts) speaks the same WebSocket side to the mod.
import type { Socket } from "node:net";
import { createHash, timingSafeEqual } from "node:crypto";
import { WebSocket } from "ws";
import { MAX_RECORD_BYTES } from "./framing.ts";

export function tokenMatches(given: unknown, expected: string): boolean {
  if (typeof given !== "string") return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export interface Peer {
  send(json: string): void;
  buffered(): number;
  end(): void;
  destroy(): void;
  readonly open: boolean;
  readonly keepalive: boolean;
}

export function tcpPeer(socket: Socket, keepalive = true): Peer {
  return {
    send: (json) => void socket.write(json + "\n"),
    buffered: () => socket.writableLength,
    end: () => void socket.end(),
    destroy: () => void socket.destroy(),
    get open() { return !socket.destroyed; },
    keepalive,
  };
}

/**
 * Herdr's runtime closes a WebSocket when 8 messages wait unread, as they do while any mod keeps
 * the app's JS thread busy. So the mod ACKs each message as it reads it, and at most WS_WINDOW
 * go unacknowledged; records wait here meanwhile and go out together when a slot frees, in
 * messages of at most MAX_RECORD_BYTES (the runtime's message limit too).
 */
export const WS_WINDOW = 4;
export const WS_ACK = '{"t":"ack"}';

export function wsPeer(ws: WebSocket): Peer & { acked(): void } {
  const waiting: { json: string; bytes: number }[] = [];
  let waitingBytes = 0;
  let unacked = 0;
  let ending = false;
  const pump = (): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    while (unacked < WS_WINDOW && waiting.length) {
      let n = 0;
      let size = 0;
      for (const r of waiting) {
        const joined = n === 0 ? r.bytes : size + 1 + r.bytes;
        if (n > 0 && joined > MAX_RECORD_BYTES) break;
        size = joined;
        n++;
      }
      const batch = waiting.splice(0, n);
      for (const r of batch) waitingBytes -= r.bytes;
      ws.send(batch.map((r) => r.json).join("\n"));
      unacked++;
    }
    if (ending && !waiting.length) ws.close(1000);
  };
  return {
    send: (json) => {
      const bytes = Buffer.byteLength(json);
      waiting.push({ json, bytes });
      waitingBytes += bytes;
      pump();
    },
    acked: () => {
      if (unacked > 0) unacked--;
      pump();
    },
    buffered: () => waitingBytes + ws.bufferedAmount,
    end: () => {
      ending = true;
      pump();
    },
    destroy: () => ws.terminate(),
    get open() { return ws.readyState === WebSocket.OPEN; },
    keepalive: false,
  };
}
