// Two private herdr-core sessions on this box, B added to A as a machine with `--via` (a shell, like
// ssh): a real core-to-core machine link with no network. Never the person's own session: every
// hc call carries this rig's HC_SESSION and XDG dirs.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, realpathSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const HC = process.env.HERDR_CHAT_TEST_HC || "hc";

/** Why the relay tests can't run here, or null. */
export function hcUnusable(): string | null {
  const r = spawnSync(HC, ["--version"], { encoding: "utf8" });
  if (r.error || r.status !== 0) return `hc is not usable here (${r.error?.message ?? r.stderr.trim()})`;
  return null;
}

export class Rig {
  dir: string;
  /** The Mac side: the relay's core. */
  a: string;
  /** The remote machine's session, `machine` in A. */
  b: string;
  machine = "rb";
  private base: NodeJS.ProcessEnv;
  private viaPids: string;

  constructor() {
    this.dir = realpathSync(mkdtempSync(join(tmpdir(), "hcrig-")));
    const tag = `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.a = `hcrig${tag}a`;
    this.b = `hcrig${tag}b`;
    const base: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("HC_") && !k.startsWith("HERDR_")) base[k] = v;
    for (const d of ["state", "config", "run"]) mkdirSync(join(this.dir, d), { recursive: true, mode: 0o700 });
    base.XDG_STATE_HOME = join(this.dir, "state");
    base.XDG_CONFIG_HOME = join(this.dir, "config");
    base.XDG_RUNTIME_DIR = join(this.dir, "run");
    this.base = base;
    this.viaPids = join(this.dir, "via.pids");
  }

  /** The environment for a client of session `s` (default A). */
  env(s: string = this.a): NodeJS.ProcessEnv {
    return { ...this.base, HC_SESSION: s };
  }

  hc(args: string[], s: string = this.a): string {
    return execFileSync(HC, args, { env: this.env(s), encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
  }

  start(): this {
    const via = join(this.dir, "via.sh");
    // Each link's shell records its pid: a test kills it to drop the machine link, and keeps it
    // down while the `down` file exists.
    writeFileSync(via, `#!/bin/sh\n[ -e '${join(this.dir, "down")}' ] && exit 1\necho $$ >> '${this.viaPids}'\nexec sh -c "$1"\n`);
    chmodSync(via, 0o755);
    this.hc(["server", "start"], this.a);
    this.hc(["server", "start"], this.b);
    this.hc(["machine", "add", "--via", via, "--name", this.machine, "--session", this.b], this.a);
    return this;
  }

  /** The live link shells (each runs B's `herdr-core connect`). */
  linkPids(): number[] {
    if (!existsSync(this.viaPids)) return [];
    return readFileSync(this.viaPids, "utf8").split("\n").filter(Boolean).map(Number).filter((p) => {
      try {
        return readFileSync(`/proc/${p}/cmdline`, "utf8").includes(this.b);
      } catch {
        return false;
      }
    });
  }

  /** Drops the machine link; with `hold`, it stays down until up(). */
  drop(hold = false): void {
    if (hold) writeFileSync(join(this.dir, "down"), "");
    for (const p of this.linkPids()) {
      // The shell's child is B's `herdr-core connect`: the link lives in it.
      spawnSync("pkill", ["-KILL", "-P", String(p)], { stdio: "ignore" });
      try {
        process.kill(p, "SIGKILL");
      } catch {}
    }
  }

  up(): void {
    rmSync(join(this.dir, "down"), { force: true });
  }

  /** B's terminals carrying `label` (k=v). */
  terminals(label: string): { address: string; state: string; pid?: number }[] {
    const out = this.hc(["ls", "--json", "--all", "--label", label], this.b);
    const j = JSON.parse(out);
    return (Array.isArray(j) ? j : j.terminals ?? []) as any[];
  }

  stop(): void {
    for (const s of [this.a, this.b]) spawnSync(HC, ["server", "stop"], { env: this.env(s), timeout: 30_000, stdio: "ignore" });
    this.drop();
    rmSync(this.dir, { recursive: true, force: true });
  }
}
