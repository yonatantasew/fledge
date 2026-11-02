import assert from "node:assert/strict";
import test from "node:test";
import { parseGhAccounts, parseJiraProjects } from "./suggestions.ts";

test("gh accounts, the active one first", () => {
  const out = [
    "github.com",
    "  ✓ Logged in to github.com account ana-work (keyring)",
    "  - Active account: false",
    "  - Git operations protocol: https",
    "",
    "  ✓ Logged in to github.com account ana (keyring)",
    "  - Active account: true",
    "  - Git operations protocol: https",
  ].join("\n");
  assert.deepEqual(parseGhAccounts(out), [
    { value: "ana", label: "github.com · active" },
    { value: "ana-work", label: "github.com" },
  ]);
  assert.deepEqual(parseGhAccounts("You are not logged into any GitHub hosts."), []);
});

test("Jira projects as key and name, from either JSON shape", () => {
  assert.deepEqual(parseJiraProjects('[{"key":"APP","name":"The app"},{"name":"no key"}]'), [{ value: "APP", label: "The app" }]);
  assert.deepEqual(parseJiraProjects('{"values":[{"key":"WEB","name":"Web"}]}'), [{ value: "WEB", label: "Web" }]);
});
