// A WebSocket client as the chat mod is one: it ACKs each message unless held.
import WebSocket from "ws";
import { sleep } from "./harness.ts";

export type Rec = Record<string, any>;

export class WsClient {
  ws: WebSocket;
  records: Rec[] = [];
  nonJson: string[] = [];
  messages = 0;
  holding = false;
  private unacked = 0;
  closed = false;
  upgraded = false;
  private nextId = 0;
  private replies = new Map<string, (r: Rec) => void>();

  constructor(port: number, headers: Record<string, string> = {}) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers });
    this.ws.on("upgrade", () => (this.upgraded = true));
    this.ws.on("message", (data) => {
      this.messages++;
      if (this.holding) this.unacked++;
      else this.ack();
      for (const text of String(data).split("\n")) {
        let rec: Rec;
        try {
          rec = JSON.parse(text);
        } catch {
          this.nonJson.push(text.slice(0, 200));
          continue;
        }
        this.records.push(rec);
        if (rec.t === "res") this.replies.get(rec.id)?.(rec);
      }
    });
    this.ws.on("error", () => {});
    this.ws.on("close", () => (this.closed = true));
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("close", () => reject(new Error("closed before open")));
    });
  }

  send(rec: Rec): void {
    this.ws.send(JSON.stringify(rec));
  }

  private ack(): void {
    this.send({ t: "ack" });
  }

  resume(): void {
    this.holding = false;
    for (; this.unacked > 0; this.unacked--) this.ack();
  }

  req(op: string, args: Rec = {}): Promise<Rec> {
    const id = `w${++this.nextId}`;
    return new Promise((resolve) => {
      this.replies.set(id, resolve);
      this.send({ t: "req", id, op, ...args });
    });
  }

  async until(pred: () => boolean, ms: number, what: string): Promise<void> {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
      await sleep(20);
    }
  }
}

export const withoutPings = (recs: Rec[]) => recs.filter((r) => r.t !== "ping");
export const withoutSeq = ({ seq, ...r }: Rec) => r;
