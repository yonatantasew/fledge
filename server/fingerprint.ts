// What a checkout's files are, as one hash: its commit, the status of every
// file, the uncommitted changes, and the size and time of untracked files.
// Ignored files (build output) don't count. Equal fingerprints mean a build
// would see the same sources, which is what resuming a stopped build needs.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function fingerprint(checkout: string) {
  const git = (...a: string[]) => run("git", ["-C", checkout, ...a], { maxBuffer: 256 << 20 }).then((r) => r.stdout);
  const [head, status, diff, untracked] = await Promise.all([
    git("rev-parse", "HEAD"),
    git("status", "--porcelain=v1", "-uall"),
    git("diff", "HEAD", "--binary"),
    git("ls-files", "--others", "--exclude-standard", "-z"),
  ]);
  const hash = createHash("sha256").update(head).update(status).update(diff);
  for (const f of untracked.split("\0").filter(Boolean).slice(0, 5000)) {
    const st = await stat(path.join(checkout, f)).catch(() => null);
    hash.update(`${f}:${st?.size}:${st?.mtimeMs}\n`);
  }
  return hash.digest("hex");
}
