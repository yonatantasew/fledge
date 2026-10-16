import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// The registry reads FLEDGE_HOME when the module loads, so set it first.
const home = mkdtempSync(path.join(tmpdir(), "fledge-home-"));
process.env.FLEDGE_HOME = home;
const { addProject, getProject, listProjects, localConfigPath, removeProject, saveLocalConfig } = await import("./projects.ts");

function flutterRepo(name: string) {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "fledge-app-")), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "pubspec.yaml"), "name: x\nversion: 1.0.0+1\n");
  execFileSync("git", ["init", "-q", dir]);
  return dir;
}

const good = { flavors: [{ name: "dev" }] };

test("registers an app once, from any folder inside it", async () => {
  const repo = flutterRepo("My App");
  mkdirSync(path.join(repo, "lib"));
  const a = await addProject(path.join(repo, "lib"));
  const b = await addProject(repo);
  assert.equal(a.id, "my-app");
  assert.equal(b.id, "my-app");
  assert.equal((await listProjects()).filter((p) => p.id === "my-app").length, 1);
});

test("ids stay unique for apps with the same folder name", async () => {
  const a = await addProject(flutterRepo("twin"));
  const b = await addProject(flutterRepo("twin"));
  assert.notEqual(a.id, b.id);
});

test("refuses folders that aren't Flutter repositories", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fledge-not-"));
  await assert.rejects(addProject(dir), /not inside a Flutter project/);
});

test("config precedence: explicit, then local, then the repo's fledge.json", async () => {
  const repo = flutterRepo("precedence");
  const entry = await addProject(repo);
  assert.equal((await getProject(entry.id))!.source, null);

  writeFileSync(path.join(repo, "fledge.json"), JSON.stringify({ flavors: [{ name: "repo" }] }));
  let p = (await getProject(entry.id))!;
  assert.equal(p.source, "repo");
  assert.equal(p.config!.flavors[0].name, "repo");

  await saveLocalConfig(entry.id, { flavors: [{ name: "local" }] });
  p = (await getProject(entry.id))!;
  assert.equal(p.source, "local");
  assert.equal(p.config!.flavors[0].name, "local");
  assert.equal(p.configFile, localConfigPath(entry.id));

  const explicit = path.join(repo, "mine.json");
  writeFileSync(explicit, JSON.stringify({ flavors: [{ name: "explicit" }] }));
  await addProject(repo, { config: explicit });
  p = (await getProject(entry.id))!;
  assert.equal(p.source, "explicit");
  assert.equal(p.config!.flavors[0].name, "explicit");
});

test("an invalid config is reported, not thrown", async () => {
  const repo = flutterRepo("broken");
  writeFileSync(path.join(repo, "fledge.json"), JSON.stringify({ flavors: [] }));
  const p = (await getProject((await addProject(repo)).id))!;
  assert.equal(p.config, null);
  assert.match(p.error!, /flavors/);
});

test("saveLocalConfig refuses an invalid config and bad ids", async () => {
  const { id } = await addProject(flutterRepo("save"));
  await assert.rejects(saveLocalConfig(id, { flavors: [] }), /flavors/);
  await assert.rejects(saveLocalConfig("../escape", good), /bad project id/);
  await saveLocalConfig(id, good);
});

test("getProject ignores unknown or malformed ids, and removing forgets the app", async () => {
  assert.equal(await getProject("nope"), null);
  assert.equal(await getProject("../x"), null);
  const { id } = await addProject(flutterRepo("gone"));
  await removeProject(id);
  assert.equal(await getProject(id), null);
});
