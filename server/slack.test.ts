import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { channelId, shipFile, shipFiles } from "./slack.ts";

const dir = mkdtempSync(path.join(tmpdir(), "fledge-slack-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// A fake Slack: records every call and answers like the real API.
function fakeSlack(answers: Record<string, unknown>) {
  const calls: { url: string; body: unknown; auth?: string }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: init.body, auth: (init.headers as Record<string, string> | undefined)?.authorization });
    const method = String(url).replace("https://slack.com/api/", "");
    if (String(url).startsWith("https://files.example/")) return new Response("OK", { status: 200 });
    return Response.json(answers[method] ?? { ok: false, error: "unknown_method" });
  }) as typeof fetch;
  return calls;
}

test("a channel name is looked up across pages; an id passes through", async () => {
  const calls = fakeSlack({});
  let page = 0;
  globalThis.fetch = (async (url: string) => {
    calls.push({ url: String(url), body: null });
    page++;
    return Response.json(
      page === 1
        ? { ok: true, channels: [{ id: "C1", name: "general" }], response_metadata: { next_cursor: "next" } }
        : { ok: true, channels: [{ id: "C2", name: "deployments" }], response_metadata: { next_cursor: "" } },
    );
  }) as typeof fetch;
  assert.equal(await channelId("xoxb-t", "#deployments"), "C2");
  assert.equal(page, 2);
  assert.equal(await channelId("xoxb-t", "C0123ABCD"), "C0123ABCD");
});

test("shipping uploads the bytes, then shares the file in the channel with the message", async () => {
  const file = path.join(dir, "app.apk");
  writeFileSync(file, "apk bytes");
  const calls = fakeSlack({
    "files.getUploadURLExternal": { ok: true, upload_url: "https://files.example/up", file_id: "F1" },
    "files.completeUploadExternal": { ok: true, files: [{ id: "F1" }] },
  });
  const lines: string[] = [];
  assert.equal(await shipFile("xoxb-t", "C9", { path: file, name: "app.apk" }, "*demo* 1.0.0", (l) => lines.push(l)), "F1");
  assert.deepEqual(calls.map((c) => c.url), [
    "https://slack.com/api/files.getUploadURLExternal",
    "https://files.example/up",
    "https://slack.com/api/files.completeUploadExternal",
  ]);
  assert.equal(calls[0].auth, "Bearer xoxb-t");
  assert.equal(String(calls[0].body), "filename=app.apk&length=9");
  assert.equal(Buffer.from(calls[1].body as Uint8Array).toString(), "apk bytes");
  const done = new URLSearchParams(String(calls[2].body));
  assert.deepEqual([done.get("files"), done.get("channel_id"), done.get("initial_comment")], [JSON.stringify([{ id: "F1", title: "app.apk" }]), "C9", "*demo* 1.0.0"]);
});

test("Slack's errors come back with what to do about them", async () => {
  const file = path.join(dir, "b.apk");
  writeFileSync(file, "x");
  fakeSlack({
    "files.getUploadURLExternal": { ok: true, upload_url: "https://files.example/up", file_id: "F2" },
    "files.completeUploadExternal": { ok: false, error: "not_in_channel" },
  });
  await assert.rejects(shipFile("xoxb-t", "C9", { path: file, name: "b.apk" }, "m", () => {}), /not_in_channel — the bot isn't in that channel; in Slack, type \/invite/);
});

test("several files go up one by one, then share in one message", async () => {
  const a = path.join(dir, "a.apk");
  const i = path.join(dir, "i.ipa");
  writeFileSync(a, "a");
  writeFileSync(i, "ii");
  let n = 0;
  const calls = fakeSlack({});
  const inner = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (String(url).endsWith("files.getUploadURLExternal")) {
      calls.push({ url: String(url), body: init.body });
      n++;
      return Response.json({ ok: true, upload_url: `https://files.example/${n}`, file_id: `F${n}` });
    }
    if (String(url).endsWith("files.completeUploadExternal")) {
      calls.push({ url: String(url), body: init.body });
      return Response.json({ ok: true });
    }
    return inner(url, init);
  }) as typeof fetch;
  assert.deepEqual(await shipFiles("xoxb-t", "C9", [{ path: a, name: "a.apk" }, { path: i, name: "i.ipa" }], "notes", () => {}), ["F1", "F2"]);
  const done = new URLSearchParams(String(calls.at(-1)!.body));
  assert.deepEqual(JSON.parse(done.get("files")!), [{ id: "F1", title: "a.apk" }, { id: "F2", title: "i.ipa" }]);
  assert.equal(calls.filter((c) => c.url.endsWith("completeUploadExternal")).length, 1);
  await assert.rejects(shipFiles("xoxb-t", "C9", [], "x", () => {}), /1 to 10 files/);
});
