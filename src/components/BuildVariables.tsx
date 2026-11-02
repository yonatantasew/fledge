import { Delete02Icon, Loading03Icon, LockKeyIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { projectsApi } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// Names that hold secrets get a password field; others (an org, a project) are shown as typed.
const SECRET = /TOKEN|SECRET|PASSWORD|KEY|DSN/;

/**
 * Rows for build variables: each says whether fledge keeps it for the app, and
 * takes a new value. Values are written to the Keychain and never shown again.
 */
export function VariableRows({
  appId,
  names,
  stored,
  onChange,
}: {
  appId: string;
  names: string[];
  stored: string[];
  onChange: (names: string[]) => void;
}) {
  return (
    <div className="space-y-2">
      {names.map((n) => (
        <VariableRow key={n} appId={appId} name={n} isStored={stored.includes(n)} onChange={onChange} />
      ))}
    </div>
  );
}

function VariableRow({ appId, name, isStored, onChange }: { appId: string; name: string; isStored: boolean; onChange: (names: string[]) => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const secret = SECRET.test(name);

  async function save(v: string | null) {
    setBusy(true);
    setError(null);
    try {
      onChange((await projectsApi.setEnv(appId, name, v)).names);
      setValue("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 font-mono text-xs break-all">{name}</span>
        <span className={cn("text-xs", isStored ? "text-success" : "text-muted-foreground")}>{isStored ? "set in fledge" : "not set in fledge"}</span>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) void save(value.trim());
        }}
      >
        <Input
          type={secret ? "password" : "text"}
          autoComplete="off"
          spellCheck={false}
          className="h-8 font-mono text-xs md:text-xs"
          placeholder={isStored ? "Replace the value" : secret ? "Paste the value" : "Value"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label={`${name} value`}
        />
        <Button type="submit" size="sm" disabled={busy || !value.trim()}>
          {busy ? <HugeiconsIcon icon={Loading03Icon} className="size-4 animate-spin" /> : "Save"}
        </Button>
        {isStored && (
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void save(null)} aria-label={`Remove ${name}`}>
            <HugeiconsIcon icon={Delete02Icon} className="size-4" />
          </Button>
        )}
      </form>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/** The app's other build variables (a service's own are on its card), and a row to add one. */
export function BuildVariables({
  appId,
  names,
  onChange,
  shownAbove = [],
}: {
  appId: string;
  names: string[];
  onChange: (names: string[]) => void;
  shownAbove?: string[];
}) {
  const [adding, setAdding] = useState("");
  const name = adding.trim().toUpperCase();
  const [extra, setExtra] = useState<string[]>([]); // added names waiting for a value
  const shown = [...new Set([...names, ...extra])].filter((n) => !shownAbove.includes(n)).sort();
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <HugeiconsIcon icon={LockKeyIcon} className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">Build variables</span>
      </div>
      <p className="text-xs text-muted-foreground">
        Kept in this Mac's Keychain and given to every build of this app, on top of fledge's own environment. A change applies to the next build; no restart.
      </p>
      {shown.length > 0 && <VariableRows appId={appId} names={shown} stored={names} onChange={(n) => (onChange(n), setExtra((x) => x.filter((e) => !n.includes(e))))} />}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name) setExtra((x) => [...x, name]);
          setAdding("");
        }}
      >
        <Input
          className="h-8 font-mono text-xs md:text-xs"
          placeholder="Add a variable, e.g. API_TOKEN"
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          aria-label="New variable name"
        />
        <Button type="submit" size="sm" variant="outline" disabled={!name}>
          Add
        </Button>
      </form>
    </div>
  );
}
