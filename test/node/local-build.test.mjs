import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { lstat, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { localBuildArgs, localBuildArtifactName } from "../../dist/capture/run.js";
import { prepareExactSourceBuild } from "../../dist/capture/eas-build.js";
import { findLocalIosApp } from "../../dist/capture/local-ios-app.js";
import { writeCaptureObserverPackages } from "../helpers/capture-observer-fixture.mjs";

test("a local build uses the same profile on this machine, with a platform artifact name", () => {
  assert.equal(localBuildArtifactName("ios"), "local-build.tar.gz");
  assert.equal(localBuildArtifactName("android"), "local-build.apk");
  assert.deepEqual(localBuildArgs("ios", "explore", "/tmp/out.tar.gz"),
    ["build", "--platform", "ios", "--profile", "explore", "--local", "--output", "/tmp/out.tar.gz", "--non-interactive"]);
  assert.deepEqual(localBuildArgs("android", "explore-apk", "/tmp/out.apk"),
    ["build", "--platform", "android", "--profile", "explore-apk", "--local", "--output", "/tmp/out.apk", "--non-interactive"]);
});

async function iosArchive(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "explore-ios-archive-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundleIds = new Map();
  const app = async (relativePath, bundleId) => {
    const path = join(root, relativePath);
    await mkdir(path, { recursive: true });
    bundleIds.set(path, bundleId);
    return path;
  };
  const readBundleId = path => bundleIds.get(path) ?? "";
  return { app, readBundleId, root };
}

test("findLocalIosApp selects a flat application bundle", async t => {
  const archive = await iosArchive(t);
  const expected = await archive.app("Pulse.app", "com.example.pulse");
  assert.equal(await findLocalIosApp(archive.root, "com.example.pulse", archive.readBundleId), expected);
});

test("findLocalIosApp selects the iOS app instead of a nested watch simulator app", async t => {
  const archive = await iosArchive(t);
  await archive.app("Build/Products/Release-watchsimulator/PulseLive.app", "com.example.pulse.watch");
  const expected = await archive.app("Build/Products/Release-iphonesimulator/PulseExplore.app", "com.example.pulse.explore");
  assert.equal(await findLocalIosApp(archive.root, "com.example.pulse.explore", archive.readBundleId), expected);
});

test("findLocalIosApp rejects archives without the expected bundle id", async t => {
  const archive = await iosArchive(t);
  await archive.app("Release-iphonesimulator/Wrong.app", "com.example.wrong");
  await assert.rejects(findLocalIosApp(archive.root, "com.example.expected", archive.readBundleId), /no \.app with bundle id com\.example\.expected/);
});

test("findLocalIosApp rejects ambiguous bundle-id matches", async t => {
  const archive = await iosArchive(t);
  await archive.app("One/First.app", "com.example.pulse");
  await archive.app("Two/Second.app", "com.example.pulse");
  await assert.rejects(findLocalIosApp(archive.root, "com.example.pulse", archive.readBundleId), /more than one \.app/);
});

test("findLocalIosApp does not follow symlinked application bundles", async t => {
  const archive = await iosArchive(t);
  const expected = await archive.app("Real.app", "com.example.pulse");
  await symlink(expected, join(archive.root, "Linked.app"));
  assert.equal(await findLocalIosApp(archive.root, "com.example.pulse", archive.readBundleId), expected);
});

const route = { id: "screen", provider: "expo-router", kind: "screen", logicalPath: "/(tabs)/cats/[id]",
  route: "/cats/42", path: "/cats/42", routeFile: "app/(tabs)/cats/[id].tsx", sourceFiles: [], variant: "default", parameters: { id: "42" } };

const profile = { easEnvironment: "development", profileEnvironment: { EXPO_PUBLIC_FLAG: "1" },
  projectIdentity: { name: "Example", slug: "example", owner: "acme", projectId: "project-1" } };

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "explore-local-build-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "app"); await mkdir(project);
  await writeFile(join(project, "package.json"), '{"main":"original-entry.js"}');
  await writeFile(join(project, "original-entry.js"), "// entry");
  await writeCaptureObserverPackages(project, { provider: "expo-router" });
  const sourceApp = join(root, "Source.app"); await mkdir(sourceApp);
  await writeFile(join(sourceApp, "Info.plist"), "<plist/>");
  return { project, sourceApp, keepApp: join(root, "app.app") };
}

test("a local repack consumes a local build directly: no env pull, no download, no Expo token", async t => {
  const { project, sourceApp, keepApp } = await fixture(t);
  const calls = [];
  const runner = request => {
    calls.push(request);
    if (request.command !== "fake-repack") throw new Error(`unexpected command: ${request.command} ${request.args.join(" ")}`);
    mkdirSync(request.args[request.args.indexOf("--output") + 1], { recursive: true });
    return { stdout: "", stderr: "" };
  };
  const result = await prepareExactSourceBuild({ platform: "ios", runner, easCommand: "fake-eas", repackCommand: "fake-repack",
    project, fingerprint: "fingerprint", repackProfile: profile, easEnvironment: {}, repackEnvironment: { EXPO_TOKEN: "must-not-leak" },
    routes: [route], repack: "local", sourceApp, keepApp });
  assert.deepEqual(result, { buildId: null, app: keepApp });
  assert.ok((await lstat(keepApp)).isDirectory());
  assert.equal(calls.length, 1, "only repack-app ran; no eas env:pull or build:download");
  assert.ok(calls[0].args.includes("--source-app") && calls[0].args.includes(sourceApp));
  assert.equal(calls[0].environment.EXPO_PUBLIC_FLAG, "1");
  assert.equal("EXPO_TOKEN" in calls[0].environment, false);
});

test("a hosted repack without an Expo Build names the local alternative", async t => {
  const { project, sourceApp, keepApp } = await fixture(t);
  await assert.rejects(prepareExactSourceBuild({ platform: "ios", runner: () => ({ stdout: "", stderr: "" }), easCommand: "fake-eas", repackCommand: "fake-repack",
    project, fingerprint: "fingerprint", repackProfile: profile, easEnvironment: {}, repackEnvironment: {},
    routes: [route], repack: "eas", easProfile: "explore", sourceApp, keepApp }), /capture\.build: local/);
  await assert.rejects(lstat(keepApp), { code: "ENOENT" });
});
