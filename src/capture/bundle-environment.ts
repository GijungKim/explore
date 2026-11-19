import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { CiError } from "../shared/ci-errors.js";

/**
 * The process variable `capture --env-file` sets: the absolute path of a dotenv file whose values a local build's
 * JavaScript is bundled with, in the place Expo Services' environment variables take on a hosted build.
 */
export const BUNDLE_ENV_FILE_VARIABLE = "EXPLORE_BUNDLE_ENV_FILE";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function envFileError(message: string, file: string): CiError {
  return new CiError({ code: "BUNDLE_ENV_FILE_INVALID", stage: "configuration", message,
    nextAction: `Correct ${file}: one NAME=value per line, # for comments, values optionally in single or double quotes.`, details: { file } });
}

/**
 * Parses a dotenv file as Expo CLI reads one for a bundle, without expanding `$VARIABLES`: `NAME=value` lines, an
 * optional `export ` prefix, blank lines and `#` comments, and values in single or double quotes (double quotes
 * also take `\n`). A later line for the same name wins.
 */
export function parseBundleEnvironment(text: string, file = "the env file"): Record<string, string> {
  // A Map, then Object.fromEntries: a `__proto__=` line becomes an ordinary variable, never the object's prototype.
  const result = new Map<string, string>();
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(line);
    if (!match) throw envFileError(`Line ${index + 1} of ${file} is not NAME=value.`, file);
    const name = match[1]!;
    if (!NAME.test(name)) throw envFileError(`Line ${index + 1} of ${file} has an invalid variable name.`, file);
    let value = match[2]!;
    const quote = value[0];
    if ((quote === "\"" || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === "\"") value = value.replace(/\\n/g, "\n");
    } else {
      // An unquoted value ends at an inline comment.
      value = value.replace(/\s+#.*$/, "").trim();
    }
    result.set(name, value);
  }
  return Object.fromEntries(result);
}

/** The variables of the env file `capture --env-file` named, or undefined when none was. */
export async function readBundleEnvironment(environment: NodeJS.ProcessEnv): Promise<Record<string, string> | undefined> {
  const file = environment[BUNDLE_ENV_FILE_VARIABLE];
  if (!file) return undefined;
  let text: string;
  try { text = await readFile(file, "utf8"); }
  catch (error) {
    throw new CiError({ code: "BUNDLE_ENV_FILE_INVALID", stage: "configuration", message: `Cannot read the env file ${file}.`,
      nextAction: "Pass --env-file a readable dotenv file, or leave it out.", details: { file }, cause: error });
  }
  return parseBundleEnvironment(text, file);
}

/** A digest of the env file's variables, so a cached capture is not reused once they change. */
export function bundleEnvironmentDigest(values: Record<string, string>): string {
  const hash = createHash("sha256");
  for (const name of Object.keys(values).sort()) hash.update(`${name}\0${values[name]}\0`);
  return hash.digest("hex");
}
