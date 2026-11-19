import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { BUNDLE_ENV_FILE_VARIABLE, bundleEnvironmentDigest, parseBundleEnvironment, readBundleEnvironment } = await tsImport("../../src/capture/bundle-environment.ts", import.meta.url);

test("an env file is read as Expo CLI reads a dotenv file, without expanding variables", () => {
  const parsed = parseBundleEnvironment([
    "# review backend",
    "",
    "EXPO_PUBLIC_API_URL=https://api.example.test",
    "export EXPO_PUBLIC_AUTH_URL = https://auth.example.test  # inline comment",
    "EXPO_PUBLIC_QUOTED=\"two words # not a comment\"",
    "EXPO_PUBLIC_SINGLE='$HOME stays literal'",
    "EXPO_PUBLIC_LINES=\"a\\nb\"",
    "EXPO_PUBLIC_EMPTY=",
    "EXPO_PUBLIC_API_URL=https://later.example.test",
  ].join("\n"));
  assert.deepEqual({ ...parsed }, {
    EXPO_PUBLIC_API_URL: "https://later.example.test",
    EXPO_PUBLIC_AUTH_URL: "https://auth.example.test",
    EXPO_PUBLIC_QUOTED: "two words # not a comment",
    EXPO_PUBLIC_SINGLE: "$HOME stays literal",
    EXPO_PUBLIC_LINES: "a\nb",
    EXPO_PUBLIC_EMPTY: "",
  });
  const polluted = parseBundleEnvironment("__proto__=x");
  assert.equal(Object.getPrototypeOf(polluted), Object.prototype);
  assert.equal(Object.getOwnPropertyDescriptor(polluted, "__proto__")?.value, "x");
  assert.throws(() => parseBundleEnvironment("NOT A LINE"), { code: "BUNDLE_ENV_FILE_INVALID" });
  assert.throws(() => parseBundleEnvironment("1BAD=value"), { code: "BUNDLE_ENV_FILE_INVALID" });
});

test("the env file is read from the path capture --env-file sets, and an unreadable one fails clearly", async t => {
  const root = await mkdtemp(join(tmpdir(), "explore-env-file-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await readBundleEnvironment({}), undefined);
  const file = join(root, ".env.review");
  await writeFile(file, "EXPO_PUBLIC_API_URL=https://api.example.test\n");
  assert.deepEqual({ ...await readBundleEnvironment({ [BUNDLE_ENV_FILE_VARIABLE]: file }) }, { EXPO_PUBLIC_API_URL: "https://api.example.test" });
  await assert.rejects(readBundleEnvironment({ [BUNDLE_ENV_FILE_VARIABLE]: join(root, "missing") }), { code: "BUNDLE_ENV_FILE_INVALID" });
});

test("the cache key follows the env file's values, not their order", () => {
  const digest = bundleEnvironmentDigest({ A: "1", B: "2" });
  assert.equal(bundleEnvironmentDigest({ B: "2", A: "1" }), digest);
  assert.notEqual(bundleEnvironmentDigest({ A: "1", B: "3" }), digest);
  assert.notEqual(bundleEnvironmentDigest({ A: "12", B: "" }), bundleEnvironmentDigest({ A: "1", B: "2" }));
});
