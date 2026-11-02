import { useEffect, useId, useState } from "react";
import { suggestionsApi, type Suggestion, type SuggestionKind } from "@/api";
import { Input } from "@/components/ui/input";

// One request per kind (and account) while the page is open; the server caches for five minutes too.
const loaded = new Map<string, Promise<Suggestion[]>>();

function useSuggestions(kind: SuggestionKind, account?: string) {
  const key = `${kind}:${account ?? ""}`;
  const [list, setList] = useState<Suggestion[]>([]);
  useEffect(() => {
    let live = true;
    if (!loaded.has(key)) loaded.set(key, suggestionsApi.get(kind, account).catch(() => []));
    void loaded.get(key)!.then((l) => live && setList(l));
    return () => {
      live = false;
    };
  }, [key]);
  return list;
}

/**
 * A text field that offers what this Mac is signed in to (gh accounts and
 * repos, Jira projects, Slack channels). Any text is still accepted.
 */
export function SuggestInput({
  kind,
  account,
  ...props
}: { kind: SuggestionKind; account?: string } & React.ComponentProps<typeof Input>) {
  const id = useId();
  const list = useSuggestions(kind, account);
  return (
    <>
      <Input list={id} autoComplete="off" spellCheck={false} {...props} />
      <datalist id={id}>
        {list.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </datalist>
    </>
  );
}
