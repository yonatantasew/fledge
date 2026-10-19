// The models the assistant can use, set up in fledge's settings (never in an
// app's config). The list lives in <home>/assistant.json; API keys live in the
// macOS keychain (service "fledge-assistant", account = provider id) and are
// never sent to the browser.

import { execFile } from "node:child_process";
import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { FLEDGE_HOME } from "../projects.ts";
import { anthropicConnector, DEFAULT_ANTHROPIC_MODEL, listAnthropicModels } from "./anthropic.ts";
import { claudeCliConnector } from "./claude-cli.ts";
import { listOpenAiModels, openAiConnector } from "./openai.ts";
import type { Connector } from "./types.ts";

const run = promisify(execFile);
const FILE = path.join(FLEDGE_HOME, "assistant.json");
const KEYCHAIN_SERVICE = "fledge-assistant";

export type ProviderKind = "claude-cli" | "anthropic" | "openai";

export const PRESETS: Record<string, { label: string; kind: ProviderKind; baseUrl?: string; needsKey: boolean; modelHint: string }> = {
  "claude-cli": { label: "Claude (your claude CLI login)", kind: "claude-cli", needsKey: false, modelHint: "empty for the CLI's default, or opus / sonnet / a model ID" },
  anthropic: { label: "Anthropic API", kind: "anthropic", needsKey: true, modelHint: DEFAULT_ANTHROPIC_MODEL },
  openai: { label: "OpenAI", kind: "openai", baseUrl: "https://api.openai.com/v1", needsKey: true, modelHint: "pick from the list" },
  gemini: { label: "Google Gemini", kind: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", needsKey: true, modelHint: "pick from the list" },
  ollama: { label: "Ollama (on this Mac)", kind: "openai", baseUrl: "http://localhost:11434/v1", needsKey: false, modelHint: "a model you've pulled" },
  openrouter: { label: "OpenRouter", kind: "openai", baseUrl: "https://openrouter.ai/api/v1", needsKey: true, modelHint: "pick from the list" },
  groq: { label: "Groq", kind: "openai", baseUrl: "https://api.groq.com/openai/v1", needsKey: true, modelHint: "pick from the list" },
  lmstudio: { label: "LM Studio (on this Mac)", kind: "openai", baseUrl: "http://localhost:1234/v1", needsKey: false, modelHint: "a loaded model" },
  custom: { label: "Other OpenAI-compatible", kind: "openai", needsKey: false, modelHint: "the endpoint's model name" },
};

export interface ProviderEntry {
  id: string;
  preset: string;
  name: string;
  kind: ProviderKind;
  baseUrl?: string;
  model: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max"; // Anthropic
  fallbacks?: boolean; // Anthropic: server-side refusal fallback
}

interface Settings {
  active: string | null;
  providers: ProviderEntry[];
}

export async function readSettings(): Promise<Settings> {
  const raw = await readFile(FILE, "utf8").catch(() => null);
  if (!raw) return { active: null, providers: [] };
  const s = JSON.parse(raw) as Partial<Settings>;
  return { active: s.active ?? null, providers: Array.isArray(s.providers) ? s.providers : [] };
}

async function writeSettings(s: Settings) {
  await mkdir(FLEDGE_HOME, { recursive: true });
  await writeFile(`${FILE}.tmp`, JSON.stringify(s, null, 2) + "\n");
  await rename(`${FILE}.tmp`, FILE);
}

// ------------------------------------------------------------------ keychain

async function getKey(id: string): Promise<string | undefined> {
  return run("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", id, "-w"]).then(
    (r) => r.stdout.trim() || undefined,
    () => undefined,
  );
}

async function setKey(id: string, key: string | null) {
  if (key === null) {
    await run("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", id]).catch(() => {});
    return;
  }
  // -U updates an existing item. The key is in this process's arguments for the
  // moment `security` runs, which other processes of this user could read.
  await run("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", id, "-w", key]);
}

// --------------------------------------------------------------- operations

const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const MODEL = /^[A-Za-z0-9._:/@-]{0,120}$/;

/** Providers for the UI: settings plus whether a key is stored, never the key. */
export async function listProviders() {
  const s = await readSettings();
  return {
    active: s.active,
    presets: PRESETS,
    providers: await Promise.all(s.providers.map(async (p) => ({ ...p, hasKey: !!(await getKey(p.id)) }))),
  };
}

export async function saveProvider(input: Record<string, unknown>) {
  const preset = PRESETS[String(input.preset)];
  if (!preset) throw new Error("unknown provider type");
  const s = await readSettings();
  const id = typeof input.id === "string" && ID.test(input.id) ? input.id : `${String(input.preset)}-${Date.now().toString(36)}`;
  const model = String(input.model ?? "").trim();
  if (!MODEL.test(model)) throw new Error("model name has characters that aren't allowed");
  let baseUrl: string | undefined;
  if (preset.kind === "openai") {
    baseUrl = String(input.baseUrl ?? preset.baseUrl ?? "").trim();
    if (!/^https?:\/\/[^\s]+$/.test(baseUrl)) throw new Error("base URL must start with http:// or https://");
  }
  const entry: ProviderEntry = {
    id,
    preset: String(input.preset),
    name: String(input.name ?? preset.label).slice(0, 60) || preset.label,
    kind: preset.kind,
    baseUrl,
    model: model || (preset.kind === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : ""),
    ...(preset.kind === "anthropic"
      ? {
          effort: (["low", "medium", "high", "xhigh", "max"] as const).find((e) => e === input.effort) ?? "medium",
          fallbacks: input.fallbacks !== false,
        }
      : {}),
  };
  if (preset.kind === "openai" && !entry.model) throw new Error("pick a model");
  const i = s.providers.findIndex((p) => p.id === id);
  if (i >= 0) s.providers[i] = entry;
  else s.providers.push(entry);
  if (!s.active) s.active = id;
  if (typeof input.apiKey === "string" && input.apiKey.trim()) await setKey(id, input.apiKey.trim());
  await writeSettings(s);
  return entry;
}

export async function removeProvider(id: string) {
  const s = await readSettings();
  s.providers = s.providers.filter((p) => p.id !== id);
  if (s.active === id) s.active = s.providers[0]?.id ?? null;
  await setKey(id, null);
  await writeSettings(s);
}

export async function setActive(id: string) {
  const s = await readSettings();
  if (!s.providers.some((p) => p.id === id)) throw new Error("unknown provider");
  s.active = id;
  await writeSettings(s);
}

export async function connectorFor(id?: string): Promise<{ connector: Connector; provider: ProviderEntry }> {
  const s = await readSettings();
  const p = s.providers.find((x) => x.id === (id ?? s.active));
  if (!p) throw new Error("no assistant model is set up yet — add one in the assistant's settings");
  const apiKey = await getKey(p.id);
  if (p.kind === "anthropic") {
    return {
      provider: p,
      connector: anthropicConnector({ apiKey, model: p.model || DEFAULT_ANTHROPIC_MODEL, effort: p.effort ?? "medium", fallbacks: p.fallbacks !== false }),
    };
  }
  if (p.kind === "openai") return { provider: p, connector: openAiConnector({ baseUrl: p.baseUrl!, apiKey, model: p.model }) };
  return { provider: p, connector: claudeCliConnector({ model: p.model || undefined }) };
}

/** Models available for a provider (saved, or being set up with a key typed in the form). */
export async function availableModels(input: { id?: string; preset: string; baseUrl?: string; apiKey?: string }): Promise<string[]> {
  const preset = PRESETS[input.preset];
  if (!preset) throw new Error("unknown provider type");
  const apiKey = input.apiKey?.trim() || (input.id && ID.test(input.id) ? await getKey(input.id) : undefined);
  if (preset.kind === "anthropic") return listAnthropicModels(apiKey);
  if (preset.kind === "openai") return listOpenAiModels({ baseUrl: (input.baseUrl || preset.baseUrl)!, apiKey });
  return ["opus", "sonnet", "haiku"];
}
