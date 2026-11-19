// A log file that stays bounded: past `cap` bytes it moves to `<file>.1` (replacing the one there)
// and starts again, so at most twice the cap stays on disk however long a relay or bridges run.
import { appendFileSync, renameSync, statSync } from "node:fs";

export const LOG_CAP = 1 << 20;

export function cappedLog(file: string, prefix: () => string, cap = LOG_CAP): (m: string) => void {
  let size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
  return (m) => {
    const line = `${new Date().toISOString()} ${prefix()}${m}\n`;
    try {
      if (size + line.length > cap) {
        // Another writer of the same file (bridges of one chat) may have moved it already.
        size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
        if (size + line.length > cap) {
          renameSync(file, `${file}.1`);
          size = 0;
        }
      }
      appendFileSync(file, line, { mode: 0o600 });
      size += line.length;
    } catch {}
  };
}
