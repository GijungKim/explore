import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { captureBuild, validateExploreConfig, withRunOverrides } from "../../dist/config/explore-config.js";
import { buildApkWithGradle, gradleReleaseArgs, localProperties, preferredWindowsCmake } from "../../dist/capture/gradle-build.js";
import { quoteForCmd, spawnTarget } from "../../dist/shared/spawn-target.js";

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

  const avd = spawnTarget("C:\\sdk\\cmdline-tools\\latest\\bin\\avdmanager", ["create"], "win32", exists, undefined);
  assert.equal(avd.command, "cmd.exe");
  assert.match(avd.args[3], /avdmanager\.bat/);

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
