import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BuildEnv, envFor, envNameProblem, type SecretStore } from "./build-env.ts";

function memory(): SecretStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, get: async (a) => map.get(a), set: async (a, v) => void map.set(a, v), remove: async (a) => void map.delete(a) };
}

test("variable names: capitals only, and never ones that change how builds run", () => {
  assert.equal(envNameProblem("SENTRY_AUTH_TOKEN"), null);
  assert.match(envNameProblem("sentry_org")!, /isn't a variable name/);
  assert.match(envNameProblem("1TOKEN")!, /isn't a variable name/);
  for (const name of ["PATH", "HOME", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS", "GIT_SSH_COMMAND", "JAVA_TOOL_OPTIONS", "GRADLE_OPTS"]) {
    assert.match(envNameProblem(name)!, /changes how builds run/, name);
  }
});

test("values go to the store, names to a file, and builds get them on top of fledge's own", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fledge-env-"));
  const store = memory();
  const env = new BuildEnv(store, dir);
  assert.deepEqual(await env.set("app", "SENTRY_ORG", "acme"), ["SENTRY_ORG"]);
  assert.deepEqual(await env.set("app", "SENTRY_AUTH_TOKEN", "secret"), ["SENTRY_AUTH_TOKEN", "SENTRY_ORG"]);
  assert.equal(store.map.get("app/SENTRY_AUTH_TOKEN"), "secret");
  assert.ok(!(await readFile(path.join(dir, "app.json"), "utf8")).includes("secret"), "the names file never holds a value");
  assert.deepEqual(await env.names("other"), []);

  const built = await envFor("app", { PATH: "/bin", SENTRY_ORG: "from-shell" }, env);
  assert.deepEqual([built.PATH, built.SENTRY_ORG, built.SENTRY_AUTH_TOKEN], ["/bin", "acme", "secret"]);

  assert.deepEqual(await env.set("app", "SENTRY_ORG", ""), ["SENTRY_AUTH_TOKEN"]);
  assert.equal(store.map.has("app/SENTRY_ORG"), false);
  store.map.delete("app/SENTRY_AUTH_TOKEN"); // removed from the Keychain by hand
  assert.deepEqual(await env.values("app"), {});
});

test("refuses bad names and multi-line values before touching the store", async () => {
  const store = memory();
  const env = new BuildEnv(store, await mkdtemp(path.join(tmpdir(), "fledge-env-")));
  await assert.rejects(env.set("app", "PATH", "/tmp/evil"), /changes how builds run/);
  await assert.rejects(env.set("app", "TOKEN", "a\nb"), /one line/);
  assert.equal(store.map.size, 0);
});
