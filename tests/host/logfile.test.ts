import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cappedLog } from "../../host/logfile.ts";

test("log: past its cap the file moves aside once, so at most twice the cap stays", () => {
  const dir = mkdtempSync(join(tmpdir(), "logcap-"));
  try {
    const f = join(dir, "x.log");
    const log = cappedLog(f, () => "", 4096);
    for (let i = 0; i < 1000; i++) log(`line ${i} ${"x".repeat(50)}`);
    assert.ok(statSync(f).size <= 4096);
    assert.ok(statSync(`${f}.1`).size <= 4096);
    assert.ok(!existsSync(`${f}.2`));
    assert.match(readFileSync(f, "utf8"), /line 999 /, "the newest line is kept");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
