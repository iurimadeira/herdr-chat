// One relay per machine: `relays/<m>.locks/<n>`, numbered holder files; the highest is current.
//
// Generation n+1 is claimed with an exclusive link of a complete file, and only once generation n's
// holder is judged gone (its pid dead, or naming a process started at another time than recorded).
// Relays that judge the same holder race for the same name and one wins; a holder file is never seen
// half written; and no relay ever removes the current generation, so one that judged an old holder
// can't remove a newer relay's lock. A stop claims the next generation with no pid: the machine is
// free at once, and numbers only grow.
import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { pidAlive } from "./registry.ts";

type Holder = { pid: number | null; start: string | null };

/** When a process started, as `ps` says: with its pid, it tells a relay from a later process given the same pid. */
function procStart(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

export class MachineLock {
  readonly dir: string;
  private machine: string;
  /** The generation held, 0 for none. */
  private generation = 0;

  constructor(stateDir: string, machine: string) {
    this.dir = join(stateDir, "relays", `${machine}.locks`);
    this.machine = machine;
  }

  /** Takes the machine, or throws `already serves machine` while a live relay holds it. */
  take(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    for (let tries = 0; tries < 100; tries++) {
      const top = this.top();
      if (top) {
        let h: Holder;
        try {
          h = JSON.parse(readFileSync(join(this.dir, String(top)), "utf8"));
        } catch (e) {
          // Swept while we looked: a newer generation exists, look again.
          if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
          h = { pid: null, start: null };
        }
        if (h.pid && pidAlive(h.pid) && h.start && procStart(h.pid) === h.start) {
          throw new Error(`relay pid ${h.pid} already serves machine ${this.machine}`);
        }
      }
      if (this.claim(top + 1, { pid: process.pid, start: procStart(process.pid) })) return;
    }
    throw new Error(`the lock of machine ${this.machine} kept changing`);
  }

  /** Whether this relay still holds the machine (no newer generation took it over). */
  held(): boolean {
    return this.generation > 0 && this.top() === this.generation;
  }

  /** Frees the machine at once, if it is still ours. */
  release(): void {
    if (this.held()) this.claim(this.generation + 1, { pid: null, start: null });
    this.generation = 0;
  }

  /** Links a complete holder file as generation `n`; false when another got there first. */
  private claim(n: number, h: Holder): boolean {
    const tmp = join(this.dir, `.${process.pid}.${randomBytes(6).toString("hex")}`);
    writeFileSync(tmp, JSON.stringify(h) + "\n", { mode: 0o600 });
    try {
      linkSync(tmp, join(this.dir, String(n)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    } finally {
      try {
        unlinkSync(tmp);
      } catch {}
    }
    this.generation = h.pid ? n : 0;
    // Only the newest decides: the ones below it go.
    for (const name of readdirSync(this.dir)) {
      if (/^\d+$/.test(name) && Number(name) < n) {
        try {
          unlinkSync(join(this.dir, name));
        } catch {}
      }
    }
    return true;
  }

  private top(): number {
    let top = 0;
    for (const name of readdirSync(this.dir)) if (/^\d+$/.test(name)) top = Math.max(top, Number(name));
    return top;
  }
}
