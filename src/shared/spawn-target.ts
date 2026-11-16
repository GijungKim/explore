import { existsSync } from "node:fs";
import { basename } from "node:path";

/** What to hand to spawn or spawnSync for a command, so the same request runs on macOS, Linux and Windows. */
export type SpawnTarget = { command: string; args: string[]; windowsVerbatimArguments?: boolean };

/** Extensions Windows looks for when a command names a file without one, in the order it tries them. */
const WINDOWS_EXTENSIONS = [".exe", ".cmd", ".bat"] as const;

/** One argument quoted for cmd.exe: inside double quotes, with each quote doubled. */
export function quoteForCmd(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

/**
 * On Windows, a command path without an extension gets the one that exists beside it (an npm bin is `eas.cmd`, the SDK's
 * avdmanager is `avdmanager.bat`, adb is `adb.exe`), and a `.cmd` or `.bat` file runs through cmd.exe, since Node refuses
 * to spawn batch files directly. Every argument is quoted, so paths with spaces stay one argument. Elsewhere the
 * command is unchanged.
 */
export function spawnTarget(command: string, args: readonly string[], platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync, comSpec: string | undefined = process.env.ComSpec): SpawnTarget {
  if (platform !== "win32") return { command, args: [...args] };
  const resolved = /\.[A-Za-z0-9]+$/.test(basename(command)) ? command
    : WINDOWS_EXTENSIONS.map(extension => `${command}${extension}`).find(candidate => exists(candidate)) ?? command;
  if (!/\.(cmd|bat)$/i.test(resolved)) return { command: resolved, args: [...args] };
  const line = [resolved, ...args].map(quoteForCmd).join(" ");

  return { command: comSpec || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
}
