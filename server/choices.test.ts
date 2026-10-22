import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { choiceStore, setRoutePost } from "./choices.ts";

const dir = mkdtempSync(path.join(tmpdir(), "fledge-choices-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("choices are kept per app and route, one-offs together, and nothing else", async () => {
  const store = choiceStore(dir);
  assert.equal(await store.get("demo", "qa"), null);
  await store.set("demo", "qa", { post: "as-built", onFailure: "hold", note: "  " });
  await store.set("demo", null, { post: "together", onFailure: "post-built", channel: "#fledge-experiment", note: "🧪 test" });
  await store.set("other", "qa", { post: "together", onFailure: "hold" });
  assert.deepEqual(await store.get("demo", "qa"), { post: "as-built", onFailure: "hold" }, "a blank note isn't kept");
  assert.deepEqual(await store.get("demo", null), { post: "together", onFailure: "post-built", channel: "#fledge-experiment", note: "🧪 test" });
  assert.deepEqual(await choiceStore(dir).get("other", "qa"), { post: "together", onFailure: "hold" }, "read back from disk");
});

test("a route's default goes into the config, the rest of it untouched; bad input is refused", async () => {
  const file = path.join(dir, "app.json");
  const config = {
    flavors: [{ name: "staging" }],
    custom: { left: "alone" },
    deploy: { routes: [{ id: "qa", builds: [{ platform: "android", environment: "staging", mode: "release" }], to: { slack: "#x" } }] },
  };
  writeFileSync(file, JSON.stringify(config));
  await setRoutePost(file, "qa", "as-built", "post-built");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(saved.deploy.routes[0], { ...config.deploy.routes[0], post: "as-built", onFailure: "post-built" });
  assert.deepEqual(saved.custom, { left: "alone" });
  await assert.rejects(setRoutePost(file, "nope", "together", "hold"), /no deploy route "nope"/);
  await assert.rejects(setRoutePost(file, "qa", "each" as "together", "hold"), /\.post/);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).deploy.routes[0].post, "as-built", "a refused edit leaves the file as it was");
});
