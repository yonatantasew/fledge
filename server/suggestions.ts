// Suggestions for the config form, from what this Mac is signed in to: gh's
// accounts and their repos, acli's Jira site and projects, the Slack bot's
// channels. Mac-wide, not per app, so the add-app form can use them too. A
// service that isn't set up gives no suggestions rather than an error; the
// fields still take any text.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { slackToken } from "./slack.ts";

const run = promisify(execFile);

export interface Suggestion {
  value: string;
  label?: string; // shown next to the value, e.g. a project's name
}

export type SuggestionKind = "github-accounts" | "github-repos" | "jira-site" | "jira-projects" | "slack-channels";
export const SUGGESTION_KINDS: SuggestionKind[] = ["github-accounts", "github-repos", "jira-site", "jira-projects", "slack-channels"];

/** Logins from `gh auth status`, the active one first. */
export function parseGhAccounts(out: string): Suggestion[] {
  const accounts: Suggestion[] = [];
  const re = /Logged in to (\S+) account (\S+)[^\n]*\n(?:[^\n]*\n)*?\s*- Active account: (true|false)/g;
  for (const m of out.matchAll(re)) accounts.push({ value: m[2], label: `${m[1]}${m[3] === "true" ? " · active" : ""}` });
  return accounts.sort((a, b) => Number(b.label?.endsWith("active")) - Number(a.label?.endsWith("active")));
}

export function parseJiraProjects(json: string): Suggestion[] {
  const list = JSON.parse(json) as { key?: string; name?: string }[] | { values?: { key?: string; name?: string }[] };
  return (Array.isArray(list) ? list : (list.values ?? [])).filter((p) => p.key).map((p) => ({ value: p.key!, label: p.name }));
}

async function ghEnv(account: string | undefined) {
  if (!account) return process.env;
  const token = (await run("gh", ["auth", "token", "--user", account])).stdout.trim();
  return { ...process.env, GH_TOKEN: token };
}

async function load(kind: SuggestionKind, account: string | undefined): Promise<Suggestion[]> {
  switch (kind) {
    case "github-accounts": {
      // gh prints its status on stderr in older versions, stdout in newer.
      const r = await run("gh", ["auth", "status"]).catch((e: { stdout?: string; stderr?: string }) => e);
      return parseGhAccounts(`${r.stdout ?? ""}\n${r.stderr ?? ""}`);
    }
    case "github-repos": {
      const out = (await run("gh", ["api", "user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member", "-q", ".[] | [.full_name, (.permissions.push|tostring)] | @tsv"], { env: await ghEnv(account), maxBuffer: 8 << 20 })).stdout;
      return out
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split("\t"))
        .map(([value, push]) => ({ value, label: push === "true" ? undefined : "read only" }));
    }
    case "jira-site": {
      const site = /Site:\s*(\S+)/.exec((await run("acli", ["jira", "auth", "status"])).stdout)?.[1];
      return site ? [{ value: `https://${site}`, label: "acli" }] : [];
    }
    case "jira-projects":
      return parseJiraProjects((await run("acli", ["jira", "project", "list", "--paginate", "--json"], { maxBuffer: 8 << 20 })).stdout);
    case "slack-channels": {
      const token = await slackToken();
      if (!token) return [];
      const out: Suggestion[] = [];
      let cursor = "";
      do {
        const res = await fetch("https://slack.com/api/conversations.list", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ types: "public_channel,private_channel", exclude_archived: "true", limit: "1000", ...(cursor ? { cursor } : {}) }),
          signal: AbortSignal.timeout(15_000),
        });
        const body = (await res.json()) as { ok: boolean; channels?: { name: string; is_member?: boolean; is_private?: boolean }[]; response_metadata?: { next_cursor?: string } };
        if (!body.ok) return out;
        for (const ch of body.channels ?? []) out.push({ value: `#${ch.name}`, label: ch.is_member ? "bot is in it" : "invite the bot first" });
        cursor = body.response_metadata?.next_cursor ?? "";
      } while (cursor);
      return out.sort((a, b) => Number(b.label === "bot is in it") - Number(a.label === "bot is in it") || a.value.localeCompare(b.value));
    }
  }
}

const cache = new Map<string, { at: number; result: Promise<Suggestion[]> }>();

/** Suggestions of one kind, remembered for five minutes; empty when the service isn't set up. */
export function suggestions(kind: SuggestionKind, account?: string): Promise<Suggestion[]> {
  const key = `${kind}:${account ?? ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 300_000) return hit.result;
  const result = load(kind, account).catch(() => [] as Suggestion[]);
  cache.set(key, { at: Date.now(), result });
  return result;
}
