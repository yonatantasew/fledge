import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fingerprint } from "./fingerprint.ts";

const dir = mkdtempSync(path.join(tmpdir(), "fledge-fp-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
git("init", "-q");
git("config", "user.email", "t@example.com");
git("config", "user.name", "t");
writeFileSync(path.join(dir, ".gitignore"), "build/\n");
writeFileSync(path.join(dir, "main.dart"), "void main() {}\n");
git("add", ".");
git("commit", "-qm", "init");

test("the same files give the same fingerprint; build output doesn't count", async () => {
  const a = await fingerprint(dir);
  mkdirSync(path.join(dir, "build"), { recursive: true });
  writeFileSync(path.join(dir, "build", "app.apk"), "output");
  assert.equal(await fingerprint(dir), a);
});

test("an edit, a new file, or a new commit changes it", async () => {
  const clean = await fingerprint(dir);
  writeFileSync(path.join(dir, "main.dart"), "void main() { print(1); }\n");
  const edited = await fingerprint(dir);
  assert.notEqual(edited, clean);
  writeFileSync(path.join(dir, "new.dart"), "// new\n");
  const added = await fingerprint(dir);
  assert.notEqual(added, edited);
  git("add", ".");
  git("commit", "-qm", "more");
  assert.notEqual(await fingerprint(dir), added);
});
