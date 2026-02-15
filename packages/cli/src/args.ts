export interface CliArgs {
  command: string;
  flags: Record<string, string | boolean>;
  positionals: string[];
}

export function parseCliArgs(argv: string[]): CliArgs {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token) {
      continue;
    }

    if (token.startsWith("--")) {
      const trimmed = token.slice(2);
      const eq = trimmed.indexOf("=");

      if (eq !== -1) {
        const key = trimmed.slice(0, eq);
        const value = trimmed.slice(eq + 1);
        flags[key] = value;
        continue;
      }

      const next = rest[i + 1];
      if (next && !next.startsWith("--")) {
        flags[trimmed] = next;
        i += 1;
      } else {
        flags[trimmed] = true;
      }
      continue;
    }

    positionals.push(token);
  }

  return { command, flags, positionals };
}

export function getStringFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

export function getBooleanFlag(flags: Record<string, string | boolean>, key: string): boolean {
  const value = flags[key];
  return value === true;
}
