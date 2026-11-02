import assert from "node:assert/strict";
import test from "node:test";
import { judgeFirebase, judgeGithub, judgeJira, judgeSentry, judgeSigning, judgeSlack, parseIdentities, sentryUrl, xcodeTeam } from "./connections.ts";

test("GitHub: off without a repo, then who's signed in and whether they can push", () => {
  const base = { repo: "acme/app", account: null, ghMissing: false, login: "ana", canPush: true };
  assert.equal(judgeGithub({ ...base, repo: null }).health, "off");
  assert.equal(judgeGithub({ ...base, ghMissing: true, login: null }).summary, "The gh CLI isn't installed");
  assert.equal(judgeGithub({ ...base, account: "ana-work", login: null }).fix, "gh auth login, signing in as ana-work.");
  assert.equal(judgeGithub({ ...base, canPush: null }).health, "error");
  assert.equal(judgeGithub({ ...base, canPush: false }).health, "warn");
  const ok = judgeGithub(base);
  assert.deepEqual([ok.health, ok.summary], ["ok", "ana · acme/app"]);
});

test("Jira: signed in to the configured site, or says which site it is on", () => {
  const status = "✓ Authenticated\n  Site: acme.atlassian.net\n  Email: ana@acme.example\n";
  assert.equal(judgeJira({ site: null, acliMissing: false, status: null }).health, "off");
  assert.equal(judgeJira({ site: "https://acme.atlassian.net", acliMissing: false, status: "✗ Not authenticated" }).summary, "acli isn't signed in");
  assert.equal(judgeJira({ site: "https://other.atlassian.net", acliMissing: false, status }).summary, "acli is signed in to acme.atlassian.net, not other.atlassian.net");
  const ok = judgeJira({ site: "https://acme.atlassian.net", acliMissing: false, status });
  assert.deepEqual([ok.health, ok.summary], ["ok", "ana@acme.example · acme.atlassian.net"]);
});

test("Slack: names a missing permission and a channel the bot isn't in", () => {
  const base = {
    channels: ["#builds"],
    token: true,
    who: { team: "Acme", bot: "fledge" },
    scopes: ["chat:write", "files:write", "channels:read", "groups:read"],
    found: { "#builds": { found: true, member: true } },
  };
  assert.equal(judgeSlack({ ...base, channels: [], token: false }).health, "off");
  assert.equal(judgeSlack({ ...base, token: false }).summary, "No bot token on this Mac");
  assert.equal(judgeSlack({ ...base, who: null }).summary, "Slack rejected the bot token");
  assert.equal(judgeSlack(base).health, "ok");
  const bad = judgeSlack({ ...base, scopes: ["chat:write", "channels:read", "groups:read"], found: { "#builds": { found: true, member: false } } });
  assert.equal(bad.summary, "The bot is missing permission files:write; isn't in #builds");
  assert.match(bad.fix!, /Add files:write/);
  assert.match(bad.fix!, /\/invite @fledge/);
  assert.equal(judgeSlack({ ...base, found: {} }).summary, "The bot can't see #builds");
});

test("Firebase: off when the app doesn't use it, and how to sign back in", () => {
  assert.equal(judgeFirebase({ used: false, status: { state: "logged-out" } }).health, "off");
  assert.equal(judgeFirebase({ used: true, status: { state: "expired", email: "ana@acme.example" } }).summary, "ana@acme.example sign-in has expired");
  assert.equal(judgeFirebase({ used: true, status: { state: "ok", email: "ana@acme.example" } }).health, "ok");
});

test("Sentry: catches unset variables, a misspelled project and a missing sentry-cli", () => {
  const base = { used: true, env: { token: true, org: "acme", project: "app" }, stored: ["SENTRY_AUTH_TOKEN"], cli: "2.42.2", url: "https://de.sentry.io", probe: { status: 200 } };
  assert.equal(judgeSentry({ ...base, used: false }).health, "off");
  const unset = judgeSentry({ ...base, env: { token: false, org: "acme", project: null } });
  assert.equal(unset.summary, "Builds have no SENTRY_AUTH_TOKEN, SENTRY_PROJECT");
  assert.deepEqual(unset.needs, ["SENTRY_AUTH_TOKEN", "SENTRY_PROJECT"]);
  const typo = judgeSentry({ ...base, probe: { status: 404, detail: "Project does not exist" } });
  assert.deepEqual([typo.summary, typo.needs], ['There\'s no project "app" in acme', ["SENTRY_PROJECT"]]);
  assert.deepEqual(judgeSentry({ ...base, probe: { status: 403 } }).needs, ["SENTRY_AUTH_TOKEN"]);
  assert.equal(judgeSentry({ ...base, probe: { status: 403 } }).summary, "Sentry rejected the token for this project");
  assert.equal(judgeSentry({ ...base, probe: null }).summary, "Couldn't reach https://de.sentry.io");
  assert.equal(judgeSentry({ ...base, cli: null }).summary, "sentry-cli isn't installed");
  const ok = judgeSentry(base);
  assert.deepEqual([ok.health, ok.summary], ["ok", "acme/app"]);
  assert.ok(ok.details.includes("Token set in fledge; org from fledge's environment; project from fledge's environment"));
});

test("Sentry's URL: SENTRY_URL, else the region inside an org token", () => {
  const claims = Buffer.from(JSON.stringify({ url: "https://sentry.io", region_url: "https://de.sentry.io", org: "acme" })).toString("base64");
  assert.equal(sentryUrl({ SENTRY_URL: "https://sentry.example/" }), "https://sentry.example");
  assert.equal(sentryUrl({ SENTRY_AUTH_TOKEN: `sntrys_${claims}_secret` }), "https://de.sentry.io");
  assert.equal(sentryUrl({ SENTRY_AUTH_TOKEN: "sntryu_personal" }), "https://sentry.io");
});

test("iOS signing: a distribution certificate for the app's team", () => {
  const out = [
    '  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Apple Development: Ana (AAAAAAAAAA)"',
    '  2) 89ABCDEF0123456789ABCDEF0123456789ABCDEF "Apple Distribution: Acme Ltd (TEAM123456)"',
    "     2 valid identities found",
  ].join("\n");
  const ids = parseIdentities(out);
  assert.deepEqual(ids, ["Apple Development: Ana (AAAAAAAAAA)", "Apple Distribution: Acme Ltd (TEAM123456)"]);
  assert.equal(xcodeTeam('\t\t\t\tDEVELOPMENT_TEAM = TEAM123456;\n'), "TEAM123456");
  assert.equal(judgeSigning({ used: false, team: null, identities: [] }).health, "off");
  assert.equal(judgeSigning({ used: true, team: "TEAM123456", identities: ids }).health, "ok");
  const other = judgeSigning({ used: true, team: "OTHER12345", identities: ids });
  assert.deepEqual([other.health, other.summary], ["error", "No distribution certificate for team OTHER12345"]);
  assert.equal(judgeSigning({ used: true, team: "AAAAAAAAAA", identities: ids }).health, "warn");
});
