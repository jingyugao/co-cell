const PLACEHOLDER = /\{\{([a-z][a-z0-9_]*)\}\}/g;

export function renderAgentTaskPrompt(
  template: string,
  variables: Readonly<Record<string, string>>,
): string {
  const used = new Set<string>();
  const rendered = template.replace(PLACEHOLDER, (_match, name: string) => {
    used.add(name);
    if (!(name in variables)) {
      throw new Error(`Agent task prompt variable is missing: ${name}`);
    }
    return variables[name] ?? "";
  });
  const unused = Object.keys(variables).filter((name) => !used.has(name));
  if (unused.length > 0) {
    throw new Error(`Agent task prompt variables are unused: ${unused.join(", ")}`);
  }
  return rendered.trim();
}
