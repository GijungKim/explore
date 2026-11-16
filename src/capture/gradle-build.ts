import { copyFile, lstat, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CiError } from "../shared/ci-errors.js";
import { lstatIfExists } from "./fs-safety.js";
import { hostEmulatorAbi } from "./local-simulator.js";
import type { CommandRunner } from "./run.js";

/** The release APK Gradle writes for the app module. */
export const GRADLE_RELEASE_APK = join("app", "build", "outputs", "apk", "release", "app-release.apk");

/** The `gradlew` arguments for a release APK of one ABI: the emulator's, so nothing is compiled for the others. */
export function gradleReleaseArgs(abi: string): string[] {
  return [":app:assembleRelease", `-PreactNativeArchitectures=${abi}`, "--console=plain"];
}

/** A path as local.properties reads it: forward slashes, so a Windows path needs no escaping. */
function propertiesPath(path: string): string {
  return path.replace(/\\/g, "/");
}

/** Compare dotted versions numerically (3.31.6 > 3.22.1). */
function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number), b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }

  return 0;
}

/**
 * The SDK CMake a Windows build should use: the newest installed one from 3.31 on, whose ninja handles the long paths a
 * checkout under %TEMP% produces (the 3.22 ninja the Android Gradle plugin picks by default fails to create them).
 */
export function preferredWindowsCmake(versions: readonly string[]): string | undefined {
  return versions.filter(version => /^\d+(\.\d+)*$/.test(version) && compareVersions(version, "3.31") >= 0)
    .sort(compareVersions).at(-1);
}

/** local.properties for the generated android project: the SDK, and on Windows a CMake that handles long paths. */
export function localProperties(sdk: string, cmake: string | undefined): string {
  return `sdk.dir=${propertiesPath(sdk)}\n${cmake ? `cmake.dir=${propertiesPath(cmake)}\n` : ""}`;
}

/**
 * Build the release APK on this machine with `expo prebuild` and Gradle, the way `eas build --local` does on macOS and
 * Linux, and copy it to `output`. The environment carries the build profile's variables, which can change the native
 * project (a plugin that reads them). Only the emulator's ABI is compiled.
 */
export async function buildApkWithGradle(options: { runner: CommandRunner; project: string; environment: NodeJS.ProcessEnv; output: string;
  platform?: NodeJS.Platform; arch?: string; nodePath?: string; timeoutMs?: number }): Promise<void> {
  const platform = options.platform ?? process.platform;
  const sdk = options.environment.ANDROID_HOME || options.environment.ANDROID_SDK_ROOT;
  if (!sdk) throw new CiError({ code: "ANDROID_SDK_MISSING", stage: "build",
    message: "A Gradle build needs the Android SDK, and neither ANDROID_HOME nor ANDROID_SDK_ROOT is set.",
    nextAction: "Install the Android SDK, export ANDROID_HOME, and rerun." });
  const expoCli = join(options.project, "node_modules", "expo", "bin", "cli");
  if (!await lstatIfExists(expoCli)) throw new CiError({ code: "CAPTURE_BUILD_FAILED", stage: "build",
    message: "The project has no installed expo package, so expo prebuild cannot generate the Android project.",
    nextAction: "Install the project's dependencies, then rerun." });
  options.runner({ command: options.nodePath ?? process.execPath, args: [expoCli, "prebuild", "--platform", "android", "--no-install"],
    cwd: options.project, environment: options.environment, timeoutMs: 15 * 60_000 });
  const android = join(options.project, "android");
  const cmakeRoot = join(sdk, "cmake");
  const cmake = platform === "win32" && await lstatIfExists(cmakeRoot) ? preferredWindowsCmake(await readdir(cmakeRoot)) : undefined;
  await writeFile(join(android, "local.properties"), localProperties(sdk, cmake ? join(cmakeRoot, cmake) : undefined));
  options.runner({ command: join(android, platform === "win32" ? "gradlew.bat" : "gradlew"), args: gradleReleaseArgs(hostEmulatorAbi(options.arch)),
    cwd: android, environment: options.environment, timeoutMs: options.timeoutMs ?? 90 * 60_000 });
  const apk = join(android, GRADLE_RELEASE_APK);
  const info = await lstat(apk);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Gradle did not produce the release APK at android/app/build/outputs/apk/release");
  await copyFile(apk, options.output);
}
