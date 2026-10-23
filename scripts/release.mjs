// `npm run release`: publishes the current version as a GitHub release with the
// built package attached, which is what people install (see README → Install).
//
// A prebuilt package installs without running any scripts, so fledge has no
// install-time scripts at all. (Installing straight from the repository would
// have to build on the user's machine, which recent npm blocks until scripts
// are approved.)

import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = new URL("..", import.meta.url).pathname;
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, encoding: "utf8", ...opts }).trim();
const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const tag = `v${version}`;
const repo = "yonatantasew/fledge";

if (sh("git", ["status", "--porcelain"])) throw new Error("commit or stash your changes first");
if (sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]) !== "main") throw new Error("release from main");
sh("git", ["fetch", "--quiet", "origin", "main", "--tags"]);
if (sh("git", ["rev-parse", "HEAD"]) !== sh("git", ["rev-parse", "origin/main"])) throw new Error("push main first");
if (sh("git", ["tag", "--list", tag])) throw new Error(`${tag} already exists — bump "version" in package.json`);

execFileSync("npm", ["test"], { cwd: root, stdio: "inherit" });
const out = mkdtempSync(path.join(tmpdir(), "fledge-release-"));
try {
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" }); // fresh dist/ and dist-server/
  const file = path.join(out, sh("npm", ["pack", "--silent", "--pack-destination", out]).split("\n").pop());
  // The same package under a fixed name too, so releases/latest/download/fledge.tgz is always the newest.
  const latest = path.join(out, "fledge.tgz");
  copyFileSync(file, latest);
  execFileSync(
    "gh",
    ["release", "create", tag, file, latest, "--repo", repo, "--target", "main", "--title", `fledge ${version}`, "--generate-notes"],
    { cwd: root, stdio: "inherit" },
  );
} finally {
  rmSync(out, { recursive: true, force: true });
}
