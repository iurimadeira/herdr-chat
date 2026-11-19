#!/usr/bin/env node
// slow-connect: stands between the relay and the real `hc connect` to make core's path slow or stalled.
// Every other hc command runs the real one untouched. Environment:
//   SLOW_HC_REAL       the real hc (default `hc`)
//   SLOW_HC_DELAY_MS   every byte core sends the relay arrives this much later, in order
//   SLOW_HC_STALL      comma-separated API methods (e.g. `terminal.attach,file.read`) never passed
//                      to core while the file SLOW_HC_STALL_FILE exists: core never answers them
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const real = process.env.SLOW_HC_REAL || "hc";
const args = process.argv.slice(2);
const child = spawn(real, args, { stdio: args[0] === "connect" ? ["pipe", "pipe", "inherit"] : "inherit" });
// What core sent before it exited still arrives, late.
child.on("exit", (code, sig) => setTimeout(() => process.exit(code ?? (sig ? 1 : 0)), (Number(process.env.SLOW_HC_DELAY_MS) || 0) + 10));
for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => child.kill(s));

if (args[0] === "connect") {
  const delay = Number(process.env.SLOW_HC_DELAY_MS) || 0;
  const stall = new Set((process.env.SLOW_HC_STALL ?? "").split(",").filter(Boolean));
  const stallFile = process.env.SLOW_HC_STALL_FILE ?? "";
  const stalled = (frame) => {
    if (!stall.size || !stallFile || !existsSync(stallFile)) return false;
    try {
      return stall.has(JSON.parse(frame.toString()).method);
    } catch {
      return false;
    }
  };

  // The relay to core: its hello line, then frames [channel u32 LE][kind u8][len u32 LE][payload].
  let buf = Buffer.alloc(0);
  let framed = false;
  process.stdin.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (!framed) {
        const i = buf.indexOf(10);
        if (i < 0) return;
        child.stdin.write(buf.subarray(0, i + 1));
        buf = buf.subarray(i + 1);
        framed = true;
        continue;
      }
      if (buf.length < 9) return;
      const len = buf.readUInt32LE(5);
      if (buf.length < 9 + len) return;
      const frame = buf.subarray(0, 9 + len);
      buf = buf.subarray(9 + len);
      if (frame.readUInt32LE(0) === 0 && stalled(frame.subarray(9))) continue;
      child.stdin.write(frame);
    }
  });
  process.stdin.on("end", () => child.stdin.end());
  child.stdin.on("error", () => {});

  // Core to the relay: each chunk `delay` ms after it came, in order.
  child.stdout.on("data", (d) => {
    if (!delay) return void process.stdout.write(d);
    setTimeout(() => process.stdout.write(d), delay);
  });
}
