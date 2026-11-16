import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CiError } from "../shared/ci-errors.js";
import type { CommandRunner } from "./run.js";

const environmentSchema = z.record(z.string(), z.string());

/** A platform section of a build profile: any keys, with `env` merged key by key like the profile's own. */
const platformSectionSchema = z.looseObject({ env: environmentSchema.optional() });

/** One eas.json build profile: the keys Explore merges are typed; every other key is kept as eas config prints it. */
const buildProfileSchema = z.looseObject({
  extends: z.string().optional(),
  env: environmentSchema.optional(),
  android: platformSectionSchema.optional(),
  ios: platformSectionSchema.optional(),
});

const easJsonSchema = z.looseObject({ build: z.record(z.string(), buildProfileSchema).optional() });

/** What `expo config --json` prints: the app config, kept whole. */
const appConfigSchema = z.looseObject({});

type BuildProfile = z.infer<typeof buildProfileSchema>;
type PlatformSection = z.infer<typeof platformSectionSchema>;

/** A child section over its parent's, with `env` merged key by key, as eas.json's `extends` merges them. */
function mergeSection<T extends PlatformSection>(parent: T | undefined, child: T | undefined): T | undefined {
  if (!parent || !child) return child ?? parent;
  const merged = { ...parent, ...child };
  if (parent.env && child.env) merged.env = { ...parent.env, ...child.env };

  return merged;
}

function mergeProfiles(parent: BuildProfile, child: BuildProfile): BuildProfile {
  const merged: BuildProfile = { ...parent, ...child };
  const env = mergeSection({ env: parent.env }, { env: child.env })?.env;
  const android = mergeSection(parent.android, child.android);
  const ios = mergeSection(parent.ios, child.ios);
  if (env) merged.env = env;
  if (android) merged.android = android;
  if (ios) merged.ios = ios;

  return merged;
}

/**
 * The build profile `eas config --platform <platform> --profile <name>` prints, resolved from eas.json alone: the
 * `extends` chain merged parent first (env and the platform sections key by key), then the platform's section merged
 * into the profile, with the other platform's section and `extends` dropped.
 */
export function resolveBuildProfile(easJson: z.infer<typeof easJsonSchema>, name: string, platform: "ios" | "android"): BuildProfile {
  const chain: BuildProfile[] = [];
  const seen = new Set<string>();
  let current: string | undefined = name;
  while (current !== undefined) {
    const profile: BuildProfile | undefined = easJson.build?.[current];
    if (!profile) throw new CiError({ code: "EAS_PROFILE_MISSING", stage: "configuration",
      message: `eas.json has no build profile named ${current}.`, nextAction: "Set app.easProfile to a build profile in eas.json, then rerun." });
    if (seen.has(current)) throw new CiError({ code: "EAS_PROFILE_MISSING", stage: "configuration",
      message: `The eas.json build profile ${name} extends itself through ${current}.`, nextAction: "Remove the cycle from the extends chain in eas.json." });
    seen.add(current);
    chain.unshift(profile);
    current = profile.extends;
  }
  const { extends: _extends, android, ios, ...base } = chain.reduce(mergeProfiles, {});
  const section = platform === "android" ? android : ios;

  return section ? mergeProfiles(base, section) : base;
}

/** eas.json from the project, parsed. */
export async function readEasJson(project: string): Promise<z.infer<typeof easJsonSchema>> {
  const parsed = easJsonSchema.safeParse(JSON.parse(await readFile(join(project, "eas.json"), "utf8")));
  if (!parsed.success) throw new CiError({ code: "EAS_PROFILE_MISSING", stage: "configuration",
    message: "eas.json does not describe build profiles Explore can read.", nextAction: "Fix eas.json so eas config accepts it, then rerun." });

  return parsed.data;
}

/**
 * The build profile and app config `eas config --json` resolves, without an Expo account: the profile from eas.json and
 * the app config from `expo config`, read with the profile's env and the EAS_BUILD_* variables an EAS build sets.
 * Variables stored on Expo Services are not included, so only a capture that uses no Expo Services step reads its
 * config this way.
 */
export async function readLocalEasConfig(options: { runner: CommandRunner; project: string; platform: "ios" | "android"; profile: string;
  environment: NodeJS.ProcessEnv; nodePath?: string }): Promise<{ buildProfile: BuildProfile; appConfig: z.infer<typeof appConfigSchema>; stderr: string }> {
  const buildProfile = resolveBuildProfile(await readEasJson(options.project), options.profile, options.platform);
  const result = options.runner({ command: options.nodePath ?? process.execPath,
    args: [join(options.project, "node_modules", "expo", "bin", "cli"), "config", "--json", "--type", "public"],
    cwd: options.project, timeoutMs: 5 * 60_000,
    environment: { ...options.environment, ...buildProfile.env, EAS_BUILD_PLATFORM: options.platform, EAS_BUILD_PROFILE: options.profile } });
  const appConfig = appConfigSchema.safeParse(JSON.parse(result.stdout));
  if (!appConfig.success) throw new Error("expo config did not print an app config");

  return { buildProfile, appConfig: appConfig.data, stderr: result.stderr };
}

/** readLocalEasConfig as the output of `eas config --json`, for the code that parses that output. */
export async function localEasConfig(options: Parameters<typeof readLocalEasConfig>[0]): Promise<{ stdout: string; stderr: string }> {
  const { buildProfile, appConfig, stderr } = await readLocalEasConfig(options);

  return { stdout: JSON.stringify({ buildProfile, appConfig }), stderr };
}

/** Where the project installed @expo/fingerprint: hoisted, or nested under expo. */
function fingerprintCli(project: string, exists: (path: string) => boolean): string {
  const candidates = [join(project, "node_modules", "@expo", "fingerprint"), join(project, "node_modules", "expo", "node_modules", "@expo", "fingerprint")]
    .map(directory => join(directory, "bin", "cli.js"));
  const found = candidates.find(candidate => exists(candidate));
  if (!found) throw new CiError({ code: "CAPTURE_BUILD_FAILED", stage: "build",
    message: "The project has no installed @expo/fingerprint, so the native fingerprint cannot be computed without an Expo account.",
    nextAction: "Install the project's dependencies (expo installs @expo/fingerprint), then rerun." });

  return found;
}

/** The native fingerprint from @expo/fingerprint, the library `eas fingerprint:generate` wraps, without an Expo account. */
export function localFingerprint(options: { runner: CommandRunner; project: string; platform: "ios" | "android"; environment: NodeJS.ProcessEnv;
  nodePath?: string; exists?: (path: string) => boolean }): { stdout: string; stderr: string } {
  return options.runner({ command: options.nodePath ?? process.execPath,
    args: [fingerprintCli(options.project, options.exists ?? existsSync), "fingerprint:generate", "--platform", options.platform],
    cwd: options.project, environment: options.environment, timeoutMs: 5 * 60_000 });
}
