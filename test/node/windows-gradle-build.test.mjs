import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { captureBuild, validateExploreConfig, withRunOverrides } from "../../dist/config/explore-config.js";
import { buildApkWithGradle, gradleReleaseArgs, localProperties, preferredWindowsCmake } from "../../dist/capture/gradle-build.js";
import { quoteForCmd, spawnTarget } from "../../dist/shared/spawn-target.js";
import { posixShell, trustedGit, trustedGitEnvironment } from "../../dist/shared/trusted-git.js";

const config = (capture = {}, platform = "android") => validateExploreConfig({
  mode: "deterministic",
  app: { platform, bundleId: "com.example.app", easProfile: "preview", scheme: "example" },
  navigation: { provider: "expo-router" },
  device: { name: platform === "android" ? "pixel_7" : "iPhone 16" },
  exploration: { scope: "changes" },
  capture: { maxMinutes: 30, maxActions: 100, ...capture },
});

test("a local Android capture builds with Gradle on Windows and with eas build --local elsewhere", () => {
  const local = config({ simulator: "local" });
  assert.equal(captureBuild(local, "win32"), "gradle");
  assert.equal(captureBuild(local, "darwin"), "local");
  assert.equal(captureBuild(local, "linux"), "local");
  assert.equal(captureBuild(config({ simulator: "local" }, "ios"), "win32"), "local");
  assert.equal(captureBuild(config({ simulator: "local", build: "local" }), "win32"), "local");
  assert.equal(captureBuild(config({ simulator: "local", build: "gradle" }), "darwin"), "gradle");
});

test("capture.build and --build accept gradle", () => {
  assert.equal(config({ build: "gradle" }).capture.build, "gradle");
  assert.equal(withRunOverrides(config(), { build: "gradle" }).capture.build, "gradle");
  assert.throws(() => withRunOverrides(config(), { build: "make" }), /--build must be eas, local or gradle/);
});

test("Windows runs npm shims and SDK batch files through cmd.exe with every argument quoted", () => {
  const files = new Set(["C:\\p\\node_modules\\.bin\\eas.cmd", "C:\\sdk\\cmdline-tools\\latest\\bin\\avdmanager.bat", "C:\\sdk\\platform-tools\\adb.exe"]);
  const exists = path => files.has(path);

  assert.deepEqual(spawnTarget("C:\\sdk\\platform-tools\\adb", ["devices"], "win32", exists, "C:\\Windows\\system32\\cmd.exe"),
    { command: "C:\\sdk\\platform-tools\\adb.exe", args: ["devices"] });

  const eas = spawnTarget("C:\\p\\node_modules\\.bin\\eas", ["config", "--profile", "my profile"], "win32", exists, "C:\\Windows\\system32\\cmd.exe");
  assert.equal(eas.command, "C:\\Windows\\system32\\cmd.exe");
  assert.equal(eas.windowsVerbatimArguments, true);
  assert.deepEqual(eas.args, ["/d", "/s", "/c", "\"\"C:\\p\\node_modules\\.bin\\eas.cmd\" \"config\" \"--profile\" \"my profile\"\""]);

  const avd = spawnTarget("C:\\sdk\\cmdline-tools\\latest\\bin\\avdmanager", ["create"], "win32", exists, "");
  assert.equal(avd.command, "cmd.exe");
  assert.match(avd.args[3], /avdmanager\.bat/);

  assert.deepEqual(spawnTarget("C:\\cache\\bin\\agent-device-1.0.0-abc.mjs", ["open", "{\"a\":1}"], "win32", exists, "cmd.exe", "C:\\node\\node.exe"),
    { command: "C:\\node\\node.exe", args: ["C:\\cache\\bin\\agent-device-1.0.0-abc.mjs", "open", "{\"a\":1}"] });
  assert.deepEqual(spawnTarget("/usr/bin/eas", ["config"], "darwin", exists), { command: "/usr/bin/eas", args: ["config"] });
  assert.equal(quoteForCmd("say \"hi\""), "\"say \"\"hi\"\"\"");
});

test("a Windows Gradle build uses the newest SDK CMake from 3.31 on, with forward-slash paths", () => {
  assert.equal(preferredWindowsCmake(["3.22.1", "3.31.6", "3.31.10", "4.0.2", "notes"]), "4.0.2");
  assert.equal(preferredWindowsCmake(["3.22.1", "3.31.6", "3.31.10"]), "3.31.10");
  assert.equal(preferredWindowsCmake(["3.22.1"]), undefined);
  assert.equal(localProperties("C:\\Sdk", "C:\\Sdk\\cmake\\3.31.6"), "sdk.dir=C:/Sdk\ncmake.dir=C:/Sdk/cmake/3.31.6\n");
  assert.equal(localProperties("/opt/sdk", undefined), "sdk.dir=/opt/sdk\n");
  assert.deepEqual(gradleReleaseArgs("x86_64"), [":app:assembleRelease", "-PreactNativeArchitectures=x86_64", "--console=plain"]);
});

test("the Gradle build prebuilds, writes local.properties, builds the emulator ABI and copies the APK", async () => {
  const root = await mkdtemp(join(tmpdir(), "explore-gradle-"));
  try {
    const project = join(root, "app"), sdk = join(root, "sdk"), output = join(root, "out.apk");
    await mkdir(join(project, "node_modules", "expo", "bin"), { recursive: true });
    await writeFile(join(project, "node_modules", "expo", "bin", "cli"), "");
    await mkdir(join(sdk, "cmake", "3.22.1"), { recursive: true });
    await mkdir(join(sdk, "cmake", "3.31.6"), { recursive: true });
    const calls = [];
    const runner = request => {
      calls.push(request);
      return { stdout: "", stderr: "" };
    };
    // The APK Gradle would write; the runner only records the commands.
    await mkdir(join(project, "android", "app", "build", "outputs", "apk", "release"), { recursive: true });
    await writeFile(join(project, "android", "app", "build", "outputs", "apk", "release", "app-release.apk"), "apk");

    await buildApkWithGradle({ runner, project, environment: { ANDROID_HOME: sdk, TFT_STORE_BUILD: "1" }, output,
      platform: "win32", arch: "x64", nodePath: "node" });

    assert.deepEqual(calls.map(call => [call.command, call.args, call.cwd]), [
      ["node", [join(project, "node_modules", "expo", "bin", "cli"), "prebuild", "--platform", "android", "--no-install"], project],
      [join(project, "android", "gradlew.bat"), [":app:assembleRelease", "-PreactNativeArchitectures=x86_64", "--console=plain"], join(project, "android")],
    ]);
    assert.equal(calls[1].environment.TFT_STORE_BUILD, "1");
    assert.equal(await readFile(join(project, "android", "local.properties"), "utf8"),
      `sdk.dir=${sdk.replace(/\\/g, "/")}\ncmake.dir=${join(sdk, "cmake", "3.31.6").replace(/\\/g, "/")}\n`);
    assert.equal(await readFile(output, "utf8"), "apk");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("evidence git is /usr/bin/git on macOS and Linux, and on Windows the git.exe of an absolute PATH entry", () => {
  assert.equal(trustedGit("darwin", "/opt/bin:/usr/bin"), "/usr/bin/git");
  const exists = path => path === "C:\\Program Files\\Git\\cmd\\git.exe" || path === "repo\\git.exe";
  assert.equal(trustedGit("win32", "repo;\"C:\\Program Files\\Git\\cmd\";C:\\Windows", exists), "C:\\Program Files\\Git\\cmd\\git.exe");
  assert.equal(trustedGit("win32", "repo", exists), "git.exe");
  assert.deepEqual(trustedGitEnvironment({ A: "1" }, "darwin", { PATH: "/usr/bin", HOME: "/h" }), { PATH: "/usr/bin", A: "1" });
  assert.deepEqual(trustedGitEnvironment({}, "win32", { Path: "C:\\Git", SystemRoot: "C:\\Windows", USERPROFILE: "C:\\u" }),
    { PATH: "C:\\Git", SystemRoot: "C:\\Windows" });
});

test("on Windows a local emulator starts detached, not through /bin/sh, and a lost one is found with PowerShell", async () => {
  const { deleteLocalEmulator, startLocalEmulator } = await import("../../dist/capture/local-simulator.js");
  const root = await mkdtemp(join(tmpdir(), "explore-win-emulator-"));
  try {
    const sdk = join(root, "sdk"), directory = join(root, "capture");
    // Both ABIs, so the test runs on an Apple silicon Mac as well as an x86_64 PC.
    for (const abi of ["x86_64", "arm64-v8a"]) {
      await mkdir(join(sdk, "system-images", "android-36", "google_apis", abi), { recursive: true });
      await writeFile(join(sdk, "system-images", "android-36", "google_apis", abi, "system.img"), "");
    }
    const environment = { ANDROID_HOME: sdk, EXPLORE_CACHE_DIR: join(root, "cache") };
    const requests = [], detached = [];
    const runner = request => {
      requests.push(request);
      return { stdout: request.command === "powershell.exe" ? "" : "List of devices attached\r\n\r\n", stderr: "" };
    };
    // The AVD avdmanager would create.
    await mkdir(join(directory, "avd", "explore-head-0123abcd.avd"), { recursive: true });
    const emulator = await startLocalEmulator({ runner, device: "pixel_7", name: "explore-head-0123abcd", directory, cwd: root, environment,
      platform: "win32", startDetached: request => { detached.push(request); return 42; } });
    assert.equal(emulator.serial, "emulator-5554");
    assert.equal(requests.some(request => request.command === "/bin/sh"), false);
    assert.equal(detached.length, 1);
    assert.equal(detached[0].command, join(sdk, "emulator", "emulator"));
    assert.deepEqual(detached[0].args.slice(0, 4), ["-avd", "explore-head-0123abcd", "-port", "5554"]);
    assert.equal(detached[0].log, join(directory, "emulator.log"));
    assert.equal(detached[0].environment.ANDROID_AVD_HOME, join(directory, "avd"));

    await deleteLocalEmulator({ runner, serial: "emulator-5554", cwd: root, environment, platform: "win32" });
    const query = requests.find(request => request.command === "powershell.exe");
    assert.match(query.args.at(-1), /Win32_Process/);
    assert.match(query.args.at(-1), /-port 5554 /);
    assert.equal(requests.some(request => request.command === "pgrep"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an app's install runs in sh, on Windows the sh.exe of Git for Windows", () => {
  const exists = path => ["C:\\Git\\cmd\\git.exe", "C:\\Git\\bin\\sh.exe"].includes(path);
  assert.equal(posixShell("win32", "C:\\Git\\cmd", exists), "C:\\Git\\bin\\sh.exe");
  assert.equal(posixShell("win32", "C:\\Other", exists), "sh");
  assert.equal(posixShell("darwin", "/usr/bin"), "sh");
});

test("a fully local capture resolves the eas.json build profile the way eas config does", async () => {
  const { resolveBuildProfile } = await import("../../dist/capture/local-eas-config.js");
  const easJson = { build: {
    production: { node: "26.13.0", channel: "production", env: { TFT_STORE_BUILD: "1", SHARED: "base" } },
    preview: { extends: "production", channel: "preview", distribution: "internal", ios: { simulator: true }, android: { buildType: "apk", env: { SHARED: "android" } } },
    loop: { extends: "loop" },
  } };
  assert.deepEqual(resolveBuildProfile(easJson, "preview", "android"),
    { node: "26.13.0", channel: "preview", distribution: "internal", buildType: "apk", env: { TFT_STORE_BUILD: "1", SHARED: "android" } });
  assert.deepEqual(resolveBuildProfile(easJson, "preview", "ios"),
    { node: "26.13.0", channel: "preview", distribution: "internal", simulator: true, env: { TFT_STORE_BUILD: "1", SHARED: "base" } });
  assert.throws(() => resolveBuildProfile(easJson, "missing", "android"), /no build profile named missing/);
  assert.throws(() => resolveBuildProfile(easJson, "loop", "android"), /extends itself/);
});

test("a fully local capture reads the fingerprint with the project's @expo/fingerprint", async () => {
  const { localFingerprint } = await import("../../dist/capture/local-eas-config.js");
  const calls = [];
  const nested = join("/app", "node_modules", "expo", "node_modules", "@expo", "fingerprint", "bin", "cli.js");
  localFingerprint({ runner: request => { calls.push(request); return { stdout: "{\"hash\":\"abc\"}", stderr: "" }; },
    project: "/app", platform: "android", environment: {}, nodePath: "node", exists: path => path === nested });
  assert.deepEqual(calls[0].args, [nested, "fingerprint:generate", "--platform", "android"]);
  assert.throws(() => localFingerprint({ runner: () => ({ stdout: "", stderr: "" }), project: "/app", platform: "android", environment: {}, exists: () => false }),
    /no installed @expo\/fingerprint/);
});
