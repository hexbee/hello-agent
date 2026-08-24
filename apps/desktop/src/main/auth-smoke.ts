// Auth flow smoke probe — runs inside Electron (safeStorage needs app ready).
// Verifies §8 invariants:
//  1. Credential encrypts at rest (raw key never in the store file)
//  2. Masked hint exposes no key material
//  3. ModelRuntime resolves auth from the app CredentialStore
// Run: AUTH_SMOKE_OUT=/tmp/out.json electron . (see root package.json)

import { app } from "electron";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeStorageCredentialStore } from "./auth/credential-store.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

async function main(): Promise<void> {
  // Isolate from ambient env so the stored credential is the ONLY auth source.
  const ambient = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  const key = ambient ?? "sk-test-1234567890abcdef";

  const root = mkdtempSync(join(tmpdir(), "auth-smoke-"));
  const credFile = join(root, "credentials.json");
  const store = new SafeStorageCredentialStore(credFile);

  await store.modify("deepseek", async () => ({ type: "api_key" as const, key }));

  const described = store.describe("deepseek");
  const rawFile = readFileSync(credFile, "utf8");

  const rt = await ModelRuntime.create({
    credentials: store,
    modelsPath: join(root, "models.json"),
    modelsStorePath: join(root, "models-store.json"),
    allowModelNetwork: false,
  });
  const check = await rt.checkAuth("deepseek").catch(() => undefined);
  let deepseekModels = -1;
  let error: string | undefined;
  try {
    deepseekModels = (await rt.getAvailable("deepseek")).length;
  } catch (e) {
    error = String(e);
  }

  const result = {
    stored: described != null,
    hintMasked:
      described?.maskedHint != null &&
      !described.maskedHint!.includes(key.slice(4)),
    rawKeyNotInFile: !rawFile.includes(key),
    encryptedAtRest: rawFile.includes("enc"),
    authCheckType: check?.type ?? null,
    deepseekModels,
    error,
  };
  writeFileSync(process.env.AUTH_SMOKE_OUT ?? "/tmp/auth-smoke-out.json", JSON.stringify(result, null, 2));
}

app.whenReady().then(() => {
  main()
    .then(() => app.quit())
    .catch((e) => {
      writeFileSync(
        process.env.AUTH_SMOKE_OUT ?? "/tmp/auth-smoke-out.json",
        JSON.stringify({ fatal: String(e) }, null, 2),
      );
      app.quit();
    });
});
