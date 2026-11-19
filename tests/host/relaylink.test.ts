// The relay-bridge line protocol on its own (protocol.md "Relay and bridge"): two Links joined in memory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Link, LINK_WINDOW } from "../../host/relaylink.ts";

function pair(times?: { pingMs: number; deadMs: number }): { a: Link; b: Link; aGot: string[]; bGot: string[]; aToB: Buffer[]; bToA: Buffer[]; why: string[]; flush: () => void } {
  const aToB: Buffer[] = [];
  const bToA: Buffer[] = [];
  const a = new Link((l) => aToB.push(Buffer.from(l, "latin1")), times);
  const b = new Link((l) => bToA.push(Buffer.from(l, "latin1")), times);
  const aGot: string[] = [];
  const bGot: string[] = [];
  const why: string[] = [];
  a.onRecord = (t) => aGot.push(t);
  b.onRecord = (t) => bGot.push(t);
  a.onBroken = (w) => why.push(`a: ${w}`);
  b.onBroken = (w) => why.push(`b: ${w}`);
  const flush = (): void => {
    while (aToB.length || bToA.length) {
      for (const x of aToB.splice(0)) b.push(x);
      for (const x of bToA.splice(0)) a.push(x);
    }
  };
  return { a, b, aGot, bGot, aToB, bToA, why, flush };
}

test("link: records arrive exactly, in order, whatever their bytes and size", () => {
  const { a, aGot, b, bGot, flush, why } = pair();
  const big = JSON.stringify({ t: "x", text: "é漢🙂\u0000\u0001\u001b[31m\u007f\u0085 \n\r\t".repeat(10) + "z".repeat(3 << 20) });
  const recs = ["", '{"t":"hello"}', JSON.stringify({ u: "naïve 🙂 \u0003 \u0018" }), big, "last"];
  for (const r of recs) a.send(r);
  b.send("back");
  flush();
  assert.deepEqual(why, []);
  assert.deepEqual(bGot, recs);
  assert.deepEqual(aGot, ["back"]);
});

test("link: at most a window unacknowledged, and acks wait for a consumer that doesn't keep up", () => {
  const { a, b, aToB, bToA, bGot, why } = pair();
  let ok = false;
  b.canAck = () => ok;
  const recs = Array.from({ length: 8 }, (_, i) => String(i).repeat(1 << 20));
  for (const r of recs) a.send(r);
  const bytes = (q: Buffer[]): number => q.reduce((n, x) => n + x.length, 0);
  let maxInFlight = 0;
  const step = (): void => {
    maxInFlight = Math.max(maxInFlight, bytes(aToB));
    for (const x of aToB.splice(0)) b.push(x);
    for (const x of bToA.splice(0)) a.push(x);
  };
  step();
  step();
  assert.ok(bGot.length < 8, "stalled without acks");
  assert.equal(aToB.length, 0, "nothing more until an ack");
  assert.ok(a.queued() > 0);
  ok = true;
  b.drained();
  for (let n = 0; n < 1000 && (aToB.length || bToA.length); n++) step();
  assert.deepEqual(why, []);
  assert.deepEqual(bGot, recs);
  assert.ok(maxInFlight <= LINK_WINDOW, `in flight ${maxInFlight}`);
  assert.equal(a.queued(), 0, "nothing counted as queued once all is sent");
});

test("link: a control byte, a lost line or garbage breaks it", () => {
  for (const inject of [Buffer.from("\x18\x1b[!p"), Buffer.from('{"s":9,"t":"ping"}\n'), Buffer.from("hello\n")]) {
    const { a, b, aToB, why } = pair();
    a.send("one");
    for (const x of aToB.splice(0)) b.push(x);
    b.push(inject);
    assert.equal(why.length, 1, `${JSON.stringify(inject.toString())}: ${why}`);
    assert.ok(b.broken);
  }
});

test("link: an ack held back while the consumer lagged goes out on the next tick, with no new line", async () => {
  const { a, b, aToB, bToA, bGot, why } = pair({ pingMs: 100000, deadMs: 2000 });
  let ok = false;
  b.canAck = () => ok;
  b.start();
  a.send("x".repeat(256 * 1024));
  for (const x of aToB.splice(0)) b.push(x);
  assert.equal(bGot.length, 1);
  assert.equal(bToA.length, 0, "no ack while the consumer lags");
  ok = true;
  // No drained() call: the tick retries.
  const t0 = Date.now();
  while (!bToA.length && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 20));
  b.stop();
  assert.match(Buffer.concat(bToA).toString("latin1"), /"t":"ack"/);
  assert.deepEqual(why, []);
});

test("link: reports when its window fills, with the bytes in flight", () => {
  const { a, aToB } = pair();
  const full: number[] = [];
  a.onWindowFull = (n) => full.push(n);
  for (let i = 0; i < 4; i++) a.send("y".repeat(1 << 20));
  assert.ok(full.length >= 1, "the window filled");
  assert.ok(full.every((n) => n <= LINK_WINDOW), `in flight ${full}`);
  assert.equal(aToB.reduce((n, x) => n + x.length, 0), full[0]);
});
