// What someone picked in the deploy dialog last time, per app and route
// (one-offs share one entry), so it opens that way next time: how it posts,
// the one-off channel, and their own note line. Kept by fledge on this Mac
// (<home>/deploy-choices.json), so the browser and the installed app agree.
// A route's shared default is in the app's config instead (setRoutePost).

import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { parseConfig } from "./config.ts";

export interface DeployChoice {
  post: "together" | "as-built";
  onFailure: "hold" | "post-built";
  channel?: string; // one-offs
  note?: string;
}

type Store = Record<string, Record<string, DeployChoice>>; // app → route id or "one-off" → choice

export const choiceKey = (route: string | null) => route ?? "one-off";

export function choiceStore(home: string) {
  const file = path.join(home, "deploy-choices.json");
  const read = () => readFile(file, "utf8").then((t) => JSON.parse(t) as Store, () => ({}) as Store);
  let writing: Promise<unknown> = Promise.resolve(); // one write at a time
  return {
    async get(app: string, route: string | null): Promise<DeployChoice | null> {
      return (await read())[app]?.[choiceKey(route)] ?? null;
    },
    set(app: string, route: string | null, choice: DeployChoice) {
      const clean: DeployChoice = { post: choice.post, onFailure: choice.onFailure };
      if (choice.channel) clean.channel = choice.channel.slice(0, 81);
      if (choice.note?.trim()) clean.note = choice.note.slice(0, 2000);
      const write = writing.then(async () => {
        const all = await read();
        (all[app] ??= {})[choiceKey(route)] = clean;
        await mkdir(home, { recursive: true });
        await writeFile(`${file}.tmp`, JSON.stringify(all, null, 2));
        await rename(`${file}.tmp`, file);
      });
      writing = write.catch(() => {});
      return write;
    },
  };
}

/**
 * Makes a choice a route's default by writing post/onFailure into the app's
 * config file, keeping everything else in it. Checked like any config edit.
 */
export async function setRoutePost(configFile: string, route: string, post: DeployChoice["post"], onFailure: DeployChoice["onFailure"]) {
  const raw = JSON.parse(await readFile(configFile, "utf8")) as { deploy?: { routes?: { id?: string; post?: string; onFailure?: string }[] } };
  const r = raw.deploy?.routes?.find((x) => x.id === route);
  if (!r) throw new Error(`the config has no deploy route "${route}"`);
  r.post = post;
  r.onFailure = onFailure;
  parseConfig(raw); // throws with the field path when invalid
  await writeFile(`${configFile}.tmp`, JSON.stringify(raw, null, 2) + "\n");
  await rename(`${configFile}.tmp`, configFile);
}
