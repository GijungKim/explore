import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { localSystemImage } from "../../dist/capture/local-simulator.js";

async function sdkWith(images) {
  const sdk = await mkdtemp(join(tmpdir(), "explore-sdk-"));
  for (const [platform, tag, abi] of images) {
    const directory = join(sdk, "system-images", platform, tag, abi);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "system.img"), "");
  }
  return sdk;
}

test("a local emulator uses a minor SDK release's system image, such as android-36.1", async (t) => {
  const sdk = await sdkWith([["android-36.1", "google_apis_playstore", "x86_64"]]);
  t.after(() => rm(sdk, { recursive: true, force: true }));
  assert.deepEqual(await localSystemImage(sdk, "x86_64"), { image: "system-images;android-36.1;google_apis_playstore;x86_64", apiLevel: 36 });
});

test("a local emulator prefers the newest API level, then the newest minor release of it", async (t) => {
  const sdk = await sdkWith([
    ["android-35", "google_apis", "x86_64"],
    ["android-36", "google_apis", "x86_64"],
    ["android-36.1", "google_apis", "x86_64"],
    ["android-36.1", "google_apis", "arm64-v8a"],
    ["android-Baklava", "google_apis", "x86_64"],
  ]);
  t.after(() => rm(sdk, { recursive: true, force: true }));
  assert.deepEqual(await localSystemImage(sdk, "x86_64"), { image: "system-images;android-36.1;google_apis;x86_64", apiLevel: 36 });
  assert.deepEqual(await localSystemImage(sdk, "arm64-v8a"), { image: "system-images;android-36.1;google_apis;arm64-v8a", apiLevel: 36 });
  await assert.rejects(localSystemImage(sdk, "x86"), { code: "LOCAL_EMULATOR_IMAGE_UNAVAILABLE" });
});
