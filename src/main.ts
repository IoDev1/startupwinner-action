import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Project } from "@startupwinner/core";
import YAML from "yaml";
import { collect, send } from "./run.ts";

// Entry point on the GitHub runner. Inputs arrive as INPUT_<NAME> environment variables.

const input = (name: string) => process.env[`INPUT_${name.toUpperCase()}`]?.trim() || undefined;

async function manifest(): Promise<Partial<Project> | null> {
  const file = join(process.env.GITHUB_WORKSPACE ?? process.cwd(), ".startupwinner/project.yaml");
  try {
    return YAML.parse(await readFile(file, "utf8")) as Partial<Project>;
  } catch {
    return null; // checked out without the manifest: inputs must name the apps
  }
}

try {
  const token = input("token");
  const apiUrl = input("api-url");
  if (!token || !apiUrl) throw new Error("token and api-url are required");

  const { report, log } = await collect(
    {
      stripeKey: input("stripe-key"),
      appStoreKeyId: input("app-store-key-id"),
      appStoreIssuerId: input("app-store-issuer-id"),
      appStorePrivateKey: input("app-store-private-key"),
      appStoreBundleId: input("app-store-bundle-id"),
      playServiceAccount: input("play-service-account"),
      playPackage: input("play-package"),
    },
    await manifest(),
  );
  for (const line of log) console.log(line);
  for (const [source, error] of Object.entries(report.errors ?? {})) console.log(`::warning title=StartUpWinner ${source}::${error}`);

  await send(apiUrl, token, report);
  console.log("Sent the results to StartUpWinner (no keys were sent).");
} catch (error) {
  console.log(`::error title=StartUpWinner::${(error as Error).message}`);
  process.exitCode = 1;
}
