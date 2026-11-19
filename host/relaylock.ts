// One relay per machine: `relays/<m>.locks/<n>`, numbered holder files; the highest is current.
//
// Generation n+1 is claimed with an exclusive link of a complete file, and only once generation n's
// holder is judged gone (its pid dead, or naming a process started at another time than recorded;
// a start time that can't be read counts as the same process). Relays that judge the same holder
// race for the same name and one wins; a holder file is never seen half written; and no relay ever
// removes the current generation. A claim whose number a newer claim had already swept finds a
// higher one after its link and withdraws, so only the highest number ever serves. A stop claims
// the next generation with no pid: the machine is free at once.
import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { pidAlive } from "./registry.ts";

type Holder = { pid: number | null; start: string | null };

/**
 * When a process started: with its pid, it tells a relay from a later process given the same pid.
 * Linux: /proc's start time in clock ticks since boot (ps's lstart there is derived from the uptime
 * and may move by a second). Elsewhere `ps`'s lstart, which macOS reads from the process itself.
 */
function procStart(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // Field 22, counted after the command name's closing parenthesis (field 2 may hold spaces).
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] || null;
    } catch {
      return null;
    }
  }
  return psStart(pid);
}

/** `ps`'s lstart for a pid, in UTC (a reader's own zone would make a live holder look new); null when `ps` can't tell. */
export function psStart(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC0" }, stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * A relay's exit when another relay already serves its machine: the one code the mod reads as
 * "the relay is up", so it reads relays/<m>.json (Node's own crash is 1, a bad argument 2).
 */
export const RELAY_ALREADY_SERVES = 3;

export class AlreadyServes extends Error {}

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
        if (h.pid && pidAlive(h.pid)) {
          // A start time that can't be told (none recorded, or none read now) counts as the same process.
          const now = h.start ? procStart(h.pid) : null;
          if (!h.start || !now || now === h.start) throw new AlreadyServes(`relay pid ${h.pid} already serves machine ${this.machine}`);
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
    // `n` was free because a newer claim swept it, not because nobody took it: ours isn't current.
    if (this.top() !== n) {
      try {
        unlinkSync(join(this.dir, String(n)));
      } catch {}
      return false;
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
