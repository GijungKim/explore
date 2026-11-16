import { existsSync } from "node:fs";
import { win32 } from "node:path";

/**
 * The git that reads immutable evidence. On macOS and Linux it is /usr/bin/git, never one found on PATH. Windows has no
 * such path, so the first git.exe on PATH is used; only absolute PATH entries are searched, since Windows would
 * otherwise run a git.exe in the working directory (the checkout being read) first.
 */
export function trustedGit(platform: NodeJS.Platform = process.platform, path: string | undefined = process.env.PATH ?? process.env.Path,
  exists: (file: string) => boolean = existsSync): string {
  if (platform !== "win32") return "/usr/bin/git";
  for (const directory of (path ?? "").split(";")) {
    const entry = directory.trim().replace(/^"(.*)"$/, "$1");
    if (!entry || !win32.isAbsolute(entry)) continue;
    const candidate = win32.join(entry, "git.exe");
    if (exists(candidate)) return candidate;
  }

  return "git.exe";
}

/**
 * The environment that git runs with: PATH and the given variables, and on Windows the system variables (SystemRoot
 * and the like) that programs there need to start at all.
 */
export function trustedGitEnvironment(extra: NodeJS.ProcessEnv = {}, platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const windows = platform === "win32"
    ? Object.fromEntries(["SystemRoot", "SYSTEMROOT", "windir", "WINDIR", "ComSpec", "TEMP", "TMP"].filter(name => environment[name] !== undefined).map(name => [name, environment[name]]))
    : {};

  return { PATH: environment.PATH ?? environment.Path, ...windows, ...extra };
}
