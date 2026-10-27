import assert from "node:assert/strict";
import { test } from "node:test";
import { getIn, otherKeys, parseText, removeAt, setIn, toText } from "./config-form.ts";

test("reads the editor's text, or says why the form can't", () => {
  assert.deepEqual(parseText('{ "flutter": "fvm" }'), { value: { flutter: "fvm" } });
  assert.deepEqual(parseText("  "), { value: {} });
  assert.ok("error" in parseText("{ flutter: fvm }"));
  assert.deepEqual(parseText("[1]"), { error: "the config must be a JSON object" });
});

test("sets a nested field, creating what's missing, without touching the original", () => {
  const before = { flutter: "auto", commands: { pubGet: "{flutter} pub get" } };
  const after = setIn(before, ["ship", "slack", "channel"], "#builds");
  assert.deepEqual(after, { flutter: "auto", commands: { pubGet: "{flutter} pub get" }, ship: { slack: { channel: "#builds" } } });
  assert.deepEqual(before, { flutter: "auto", commands: { pubGet: "{flutter} pub get" } });
});

test("edits one item of a list and keeps the item's other fields", () => {
  const cfg = { flavors: [{ name: "dev", defines: { A: "1" } }, { name: "prod" }] };
  assert.deepEqual(setIn(cfg, ["flavors", 0, "iosId"], "com.example.dev"), {
    flavors: [{ name: "dev", defines: { A: "1" }, iosId: "com.example.dev" }, { name: "prod" }],
  });
});

test("clearing a field removes it, and the objects it leaves empty", () => {
  const cfg = { flutter: "auto", ship: { slack: { channel: "#builds" } } };
  assert.deepEqual(setIn(cfg, ["ship", "slack", "channel"], ""), { flutter: "auto" });
  assert.deepEqual(setIn(cfg, ["flutter"], undefined), { ship: { slack: { channel: "#builds" } } });
  assert.deepEqual(setIn({}, ["flutter"], ""), {});
});

test("null and false are values, not clearing", () => {
  assert.deepEqual(setIn({ flavors: [{ name: "app" }] }, ["flavors", 0, "flavor"], null), { flavors: [{ name: "app", flavor: null }] });
  assert.deepEqual(setIn({}, ["versions", "autoIncrement"], false), { versions: { autoIncrement: false } });
});

test("removes one item from a list", () => {
  const cfg = { toggles: [{ id: "a" }, { id: "b" }, { id: "c" }] };
  assert.deepEqual(removeAt(cfg, ["toggles"], 1), { toggles: [{ id: "a" }, { id: "c" }] });
  assert.equal(getIn(cfg, ["toggles", 2, "id"]), "c");
});

test("names the fields only Advanced edits", () => {
  assert.deepEqual(otherKeys({ name: "dev", iosId: "x", defines: {}, vars: {} }, ["name", "iosId"]), ["defines", "vars"]);
  assert.deepEqual(otherKeys(undefined, ["name"]), []);
});

test("writes the text the Advanced tab shows", () => {
  assert.equal(toText({ a: [1] }), '{\n  "a": [\n    1\n  ]\n}');
});
