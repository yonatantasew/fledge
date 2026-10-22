// Shipping builds to Slack: a bot token (from a Slack app the team makes once,
// see README → Shipping) uploads the file and posts a message in the app's
// channel. The token is per Mac, in the keychain; the channel is in the app's
// config. Files go up through Slack's external upload (files.upload is gone):
// ask for an upload URL, send the bytes there, then share the file.

import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const KEYCHAIN = { service: "fledge-slack", account: "bot-token" };
const TOKEN = /^xoxb-[A-Za-z0-9-]{20,}$/;

export async function slackToken(): Promise<string | undefined> {
  return run("security", ["find-generic-password", "-s", KEYCHAIN.service, "-a", KEYCHAIN.account, "-w"]).then(
    (r) => r.stdout.trim() || undefined,
    () => undefined,
  );
}

/** Stores a bot token after checking it with Slack; null removes it. */
export async function setSlackToken(token: string | null) {
  if (token === null) {
    await run("security", ["delete-generic-password", "-s", KEYCHAIN.service, "-a", KEYCHAIN.account]).catch(() => {});
    return null;
  }
  if (!TOKEN.test(token)) throw new Error("that isn't a bot token (they start with xoxb-)");
  const who = await whoAmI(token);
  // The token is in `security`'s arguments for a moment, readable by this user's other processes.
  await run("security", ["add-generic-password", "-U", "-s", KEYCHAIN.service, "-a", KEYCHAIN.account, "-w", token]);
  return who;
}

const HINTS: Record<string, string> = {
  not_in_channel: "the bot isn't in that channel; in Slack, type /invite @<the bot's name> there",
  channel_not_found: "Slack can't find that channel, or the bot can't see it (invite the bot to private channels)",
  missing_scope: "the Slack app is missing a permission; reinstall it from the manifest in fledge's README",
  invalid_auth: "Slack rejected the token; paste a fresh one",
  token_revoked: "the token was revoked; paste a fresh one",
  ratelimited: "Slack is rate-limiting; try again in a minute",
};

async function api(token: string, method: string, params: Record<string, string>) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const body = (await res.json()) as { ok: boolean; error?: string; [k: string]: unknown };
  if (!body.ok) throw new Error(`Slack ${method}: ${body.error ?? res.status}${body.error && HINTS[body.error] ? ` — ${HINTS[body.error]}` : ""}`);
  return body;
}

export async function whoAmI(token: string) {
  const r = await api(token, "auth.test", {});
  return { team: String(r.team ?? ""), bot: String(r.user ?? "") };
}

/** "#deployments" → its id (channel ids pass through). */
export async function channelId(token: string, channel: string) {
  if (!channel.startsWith("#")) return channel;
  const name = channel.slice(1);
  let cursor = "";
  do {
    const r = await api(token, "conversations.list", { types: "public_channel,private_channel", exclude_archived: "true", limit: "1000", ...(cursor ? { cursor } : {}) });
    const hit = (r.channels as { id: string; name: string }[]).find((c) => c.name === name);
    if (hit) return hit.id;
    cursor = (r.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "";
  } while (cursor);
  throw new Error(`Slack can't find ${channel}; invite the bot there (private channels are invisible to it until then)`);
}

/** Uploads a file into a channel with a message. Returns the uploaded file's id. */
export async function shipFile(token: string, channel: string, file: { path: string; name: string }, text: string, say: (line: string) => void) {
  const id = await channelId(token, channel);
  const { size } = await stat(file.path);
  say(`Uploading ${file.name} (${(size / 1048576).toFixed(1)} MB) to ${channel}…\n`);
  const up = await api(token, "files.getUploadURLExternal", { filename: file.name, length: String(size) });
  const sent = await fetch(String(up.upload_url), { method: "POST", body: await readFile(file.path) });
  if (!sent.ok) throw new Error(`Slack refused the upload (${sent.status})`);
  await api(token, "files.completeUploadExternal", {
    files: JSON.stringify([{ id: String(up.file_id), title: file.name }]),
    channel_id: id,
    initial_comment: text,
  });
  say(`Posted to ${channel}.\n`);
  return String(up.file_id);
}
