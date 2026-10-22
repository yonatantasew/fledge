// Shipping builds to Slack: a bot token (from a Slack app the team makes once,
// see README → Shipping) uploads the file and posts a message in the app's
// channel. The token is per Mac, in the keychain; the channel is in the app's
// config. Files go up through Slack's external upload (files.upload is gone):
// ask for an upload URL, send the bytes there, then share the file.

import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
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

const channels = new Map<string, { id: string; at: number }>();

/** "#deployments" → its id (channel ids pass through). Remembered for ten minutes. */
export async function channelId(token: string, channel: string) {
  if (!channel.startsWith("#")) return channel;
  const known = channels.get(`${token.slice(-6)}${channel}`);
  if (known && Date.now() - known.at < 600_000) return known.id;
  const name = channel.slice(1);
  let cursor = "";
  do {
    const r = await api(token, "conversations.list", { types: "public_channel,private_channel", exclude_archived: "true", limit: "1000", ...(cursor ? { cursor } : {}) });
    const hit = (r.channels as { id: string; name: string }[]).find((c) => c.name === name);
    if (hit) {
      channels.set(`${token.slice(-6)}${channel}`, { id: hit.id, at: Date.now() });
      return hit.id;
    }
    cursor = (r.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "";
  } while (cursor);
  throw new Error(`Slack can't find ${channel}; invite the bot there (private channels are invisible to it until then)`);
}

/** Uploads a file into a channel with a message. Returns the uploaded file's id. */
export async function shipFile(token: string, channel: string, file: { path: string; name: string }, text: string, say: (line: string) => void) {
  return (await shipFiles(token, channel, [file], text, say))[0];
}

/** A file's bytes as a stream, reporting how many have gone so far. */
function streamWithProgress(path: string, onBytes: (sent: number) => void) {
  let sent = 0;
  const counted = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, out) {
      sent += chunk.byteLength;
      onBytes(sent);
      out.enqueue(chunk);
    },
  });
  return (Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>).pipeThrough(counted);
}

export type UploadProgress = (file: string, sent: number, total: number) => void;

/**
 * Sends one file's bytes to Slack, streamed from disk, without sharing it
 * anywhere yet: shareFiles does that (Slack kept such an upload for at least
 * 15 minutes in a test; it discards ones never shared). Returns its id.
 */
export async function uploadFile(token: string, file: { path: string; name: string }, progress: UploadProgress = () => {}) {
  const { size } = await stat(file.path);
  const up = await api(token, "files.getUploadURLExternal", { filename: file.name, length: String(size) });
  // Streamed from disk: a 600 MB APK never sits in memory.
  const sent = await fetch(String(up.upload_url), {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "content-length": String(size) },
    body: streamWithProgress(file.path, (n) => progress(file.name, n, size)),
    duplex: "half",
  } as RequestInit);
  if (!sent.ok) throw new Error(`Slack refused the upload of ${file.name} (${sent.status})`);
  return String(up.file_id);
}

/** Shares uploaded files (1 to 10) in the channel as one message, or as a reply in a thread. Each upload can be shared once. */
export async function shareFiles(token: string, channel: string, files: { id: string; title: string }[], text: string, thread?: string) {
  if (!files.length || files.length > 10) throw new Error("one Slack message holds 1 to 10 files");
  await api(token, "files.completeUploadExternal", {
    files: JSON.stringify(files),
    channel_id: await channelId(token, channel),
    ...(text ? { initial_comment: text } : {}),
    ...(thread ? { thread_ts: thread } : {}),
  });
}

/** Posts a message (or a reply in a thread); returns its timestamp, which is how Slack names a thread. */
export async function postMessage(token: string, channel: string, text: string, thread?: string) {
  const r = await api(token, "chat.postMessage", { channel: await channelId(token, channel), text, ...(thread ? { thread_ts: thread } : {}) });
  return String(r.ts);
}

/** Uploads files (at most 10) and shares them in one message in the channel. Returns their ids. */
export async function shipFiles(
  token: string,
  channel: string,
  files: { path: string; name: string }[],
  text: string,
  say: (line: string) => void,
  progress: UploadProgress = () => {},
) {
  if (!files.length || files.length > 10) throw new Error("one Slack message holds 1 to 10 files");
  await channelId(token, channel); // a channel that isn't there fails before anything uploads
  const uploaded: { id: string; title: string }[] = [];
  for (const file of files) {
    say(`Uploading ${file.name} to ${channel}…\n`);
    uploaded.push({ id: await uploadFile(token, file, progress), title: file.name });
  }
  await shareFiles(token, channel, uploaded, text);
  say(`Posted to ${channel}.\n`);
  return uploaded.map((u) => u.id);
}
