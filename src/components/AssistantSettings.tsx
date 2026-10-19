import { CheckmarkCircle02Icon, Delete02Icon, Key01Icon, Loading03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { aiApi, type AiPreset, type AiProvider } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

/** The models the assistant can use. Keys go to the macOS keychain, never back to the page. */
export function AssistantSettings({ open, onOpenChange, onChanged }: { open: boolean; onOpenChange: (o: boolean) => void; onChanged: () => void }) {
  const [data, setData] = useState<{ active: string | null; presets: Record<string, AiPreset>; providers: AiProvider[] } | null>(null);
  const [form, setForm] = useState<Record<string, unknown> | null>(null);
  const [models, setModels] = useState<string[] | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = () => void aiApi.providers().then(setData);
  useEffect(() => {
    if (open) {
      reload();
      setForm(null);
      setError(null);
    }
  }, [open]);

  const preset = form ? data?.presets[String(form.preset)] : undefined;

  function startAdd(presetId: string) {
    const p = data!.presets[presetId];
    setForm({ preset: presetId, name: p.label, baseUrl: p.baseUrl ?? "", model: "", apiKey: "", effort: "medium", fallbacks: true });
    setModels(null);
    setError(null);
  }

  async function loadModels() {
    if (!form) return;
    setLoadingModels(true);
    setError(null);
    try {
      setModels(await aiApi.models({ id: form.id as string | undefined, preset: String(form.preset), baseUrl: String(form.baseUrl || ""), apiKey: String(form.apiKey || "") }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingModels(false);
    }
  }

  async function save() {
    setError(null);
    try {
      await aiApi.saveProvider(form!);
      setForm(null);
      reload();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Assistant models</DialogTitle>
          <DialogDescription>
            Pick which model answers. API keys are stored in your Mac's keychain and never sent to this page. What you ask
            and what fledge looks up go to the model's provider (nothing leaves the Mac with Ollama or LM Studio).
          </DialogDescription>
        </DialogHeader>

        {data && !form && (
          <div className="space-y-3">
            {data.providers.length > 0 && (
              <ul className="divide-y rounded-lg border">
                {data.providers.map((p) => (
                  <li key={p.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <button
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      onClick={() => void aiApi.setActive(p.id).then(() => (reload(), onChanged()))}
                      aria-label={`Use ${p.name}`}
                    >
                      <HugeiconsIcon icon={CheckmarkCircle02Icon} className={p.id === data.active ? "size-4 text-success" : "size-4 text-muted-foreground/30"} />
                      <span className="truncate font-medium">{p.name}</span>
                      <span className="truncate font-mono text-xs text-muted-foreground">{p.model || "default"}</span>
                    </button>
                    {p.hasKey && (
                      <Badge variant="outline" className="gap-1 text-[10px]">
                        <HugeiconsIcon icon={Key01Icon} className="size-3" />
                        key
                      </Badge>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => (setForm({ ...p, apiKey: "" }), setModels(null))}>
                      Edit
                    </Button>
                    <Button variant="ghost" size="icon" className="size-7" aria-label={`Remove ${p.name}`} onClick={() => void aiApi.removeProvider(p.id).then(() => (reload(), onChanged()))}>
                      <HugeiconsIcon icon={Delete02Icon} className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Add a model</Label>
              <Select onValueChange={startAdd}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choose a provider…" />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(data.presets).map(([id, p]) => (
                    <SelectItem key={id} value={id}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        {form && preset && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="ai-name">Name</Label>
              <Input id="ai-name" value={String(form.name ?? "")} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            {preset.kind === "openai" && (
              <div className="space-y-1.5">
                <Label htmlFor="ai-url">Base URL</Label>
                <Input id="ai-url" className="font-mono text-xs" value={String(form.baseUrl ?? "")} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
              </div>
            )}
            {preset.kind !== "claude-cli" && (
              <div className="space-y-1.5">
                <Label htmlFor="ai-key">API key {preset.needsKey ? "" : "(optional)"}</Label>
                <Input
                  id="ai-key"
                  type="password"
                  autoComplete="off"
                  placeholder={(form as { hasKey?: boolean }).hasKey ? "Saved in the keychain — type to replace" : preset.kind === "anthropic" ? "Empty: use ANTHROPIC_API_KEY or `ant auth login`" : ""}
                  value={String(form.apiKey ?? "")}
                  onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="ai-model">Model</Label>
              <div className="flex gap-2">
                {models ? (
                  <Select value={String(form.model || "")} onValueChange={(v) => setForm({ ...form, model: v })}>
                    <SelectTrigger id="ai-model" className="w-full font-mono text-xs">
                      <SelectValue placeholder="Pick a model" />
                    </SelectTrigger>
                    <SelectContent>
                      {models.map((m) => (
                        <SelectItem key={m} value={m} className="font-mono text-xs">
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input id="ai-model" className="font-mono text-xs" placeholder={preset.modelHint} value={String(form.model ?? "")} onChange={(e) => setForm({ ...form, model: e.target.value })} />
                )}
                <Button variant="outline" onClick={() => void loadModels()} disabled={loadingModels}>
                  {loadingModels ? <HugeiconsIcon icon={Loading03Icon} className="size-4 animate-spin" /> : "List models"}
                </Button>
              </div>
            </div>
            {preset.kind === "anthropic" && (
              <>
                <div className="space-y-1.5">
                  <Label>Effort</Label>
                  <Select value={String(form.effort ?? "medium")} onValueChange={(v) => setForm({ ...form, effort: v })}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {["low", "medium", "high", "xhigh", "max"].map((e) => (
                        <SelectItem key={e} value={e}>
                          {e}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <Label htmlFor="ai-fallback">Fallback on refusal</Label>
                    <p className="text-xs text-muted-foreground">If the model declines a request, the API retries it on another Claude model (supported models only).</p>
                  </div>
                  <Switch id="ai-fallback" checked={form.fallbacks !== false} onCheckedChange={(v) => setForm({ ...form, fallbacks: v })} />
                </div>
              </>
            )}
            {error && <p className="text-xs whitespace-pre-wrap text-destructive">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setForm(null)}>
                Cancel
              </Button>
              <Button onClick={() => void save()}>Save</Button>
            </div>
          </div>
        )}
        {!form && error && <p className="text-xs text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}
