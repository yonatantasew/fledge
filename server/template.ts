// {placeholder} templates from fledge.json. No imports, so the browser can use it too.

/** Fills {name} placeholders; unknown ones are left as they are. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);
}
