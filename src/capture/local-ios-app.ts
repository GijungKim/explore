import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";

export type ReadIosBundleId = (app: string) => string | Promise<string>;

/** Finds the one simulator application in an extracted EAS archive with the expected bundle id. */
export async function findLocalIosApp(
  root: string,
  expectedBundleId: string,
  readBundleId: ReadIosBundleId,
): Promise<string> {
  const candidates: string[] = [];

  const walk = async (directory: string): Promise<void> => {
    if (basename(directory).endsWith(".app")) {
      if ((await readBundleId(directory)) === expectedBundleId) candidates.push(directory);
      return;
    }

    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      await walk(join(directory, entry.name));
    }
  };

  await walk(root);
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) {
    throw new Error(`The local iOS build contains no .app with bundle id ${expectedBundleId}`);
  }
  throw new Error(
    `The local iOS build contains more than one .app with bundle id ${expectedBundleId}: ${candidates.join(", ")}`,
  );
}
