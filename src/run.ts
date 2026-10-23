import { checkStripeKey, fetchRevenue, fetchRevenueCat } from "@startupwinner/core";
import type { IngestPayload, Project, Revenue } from "@startupwinner/core";
import { createAppStoreJwt, fetchAppStoreStatus } from "./app-store.ts";
import { fetchPlayStatus, googleAccessToken, parseServiceAccount } from "./play.ts";

// Collects results from each configured source and builds the report. Keys are used
// here, inside the person's own GitHub runner, and never leave it (D16, D17).

export const ACTION_VERSION = "1.1.0";

export interface Inputs {
  stripeKey?: string;
  appStoreKeyId?: string;
  appStoreIssuerId?: string;
  appStorePrivateKey?: string;
  appStoreBundleId?: string;
  playServiceAccount?: string;
  playPackage?: string;
  revenueCatKey?: string;
  revenueCatProjectId?: string;
  revenueCatCurrency?: string;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);

export async function collect(inputs: Inputs, manifest: Partial<Project> | null, fetchImpl: typeof fetch = fetch) {
  const report: IngestPayload & { stripe?: Revenue } = { action_version: ACTION_VERSION, errors: {} };
  const errors = report.errors!;
  const log: string[] = [];

  if (inputs.stripeKey) {
    try {
      const check = await checkStripeKey(inputs.stripeKey, fetchImpl);
      if (!check.ok) throw new Error(check.reason);
      report.stripe = await fetchRevenue(inputs.stripeKey.trim(), Date.now(), fetchImpl);
      log.push(`Stripe: read (${report.stripe.livemode ? "live" : "test"} mode)`);
    } catch (error) {
      errors.stripe = message(error);
    }
  }

  const bundleId = inputs.appStoreBundleId || manifest?.deploy?.ios?.bundle_id;
  if (inputs.appStoreKeyId && inputs.appStoreIssuerId && inputs.appStorePrivateKey) {
    try {
      if (!bundleId) throw new Error("no bundle id: set app-store-bundle-id or deploy.ios.bundle_id in project.yaml");
      const jwt = createAppStoreJwt(inputs.appStoreKeyId, inputs.appStoreIssuerId, inputs.appStorePrivateKey.replace(/\\n/g, "\n"));
      report.app_store = await fetchAppStoreStatus(jwt, bundleId, fetchImpl);
      log.push(`App Store: ${report.app_store.latestVersion?.state ?? "no version yet"}`);
    } catch (error) {
      errors.app_store = message(error);
    }
  } else if (inputs.appStoreKeyId || inputs.appStoreIssuerId || inputs.appStorePrivateKey) {
    errors.app_store = "App Store Connect needs all three: app-store-key-id, app-store-issuer-id and app-store-private-key";
  }

  const packageName = inputs.playPackage || manifest?.deploy?.android?.package;
  if (inputs.playServiceAccount) {
    try {
      if (!packageName) throw new Error("no package name: set play-package or deploy.android.package in project.yaml");
      const token = await googleAccessToken(parseServiceAccount(inputs.playServiceAccount), fetchImpl);
      report.play = await fetchPlayStatus(token, packageName, fetchImpl);
      log.push(`Google Play: ${report.play.tracks.length} tracks`);
    } catch (error) {
      errors.play = message(error);
    }
  }

  if (inputs.revenueCatKey || inputs.revenueCatProjectId) {
    try {
      if (!inputs.revenueCatKey || !inputs.revenueCatProjectId) throw new Error("RevenueCat needs both revenuecat-key and revenuecat-project-id");
      const currency = /^[A-Z]{3}$/.test(inputs.revenueCatCurrency ?? "") ? inputs.revenueCatCurrency! : "USD";
      report.revenuecat = await fetchRevenueCat(inputs.revenueCatKey, inputs.revenueCatProjectId, fetchImpl, currency);
      log.push(`RevenueCat: ${report.revenuecat.metrics.length} metrics (${report.revenuecat.currency})`);
    } catch (error) {
      errors.revenuecat = message(error);
    }
  }

  if (!Object.keys(errors).length) delete report.errors;
  return { report, log };
}

export async function send(apiUrl: string, token: string, report: object, fetchImpl: typeof fetch = fetch) {
  const url = new URL("/api/ingest", apiUrl);
  if (url.protocol !== "https:" && url.hostname !== "localhost") throw new Error("api-url must be https");
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(report),
  });
  if (!res.ok) throw new Error(`StartUpWinner refused the report (${res.status}): ${(await res.text()).slice(0, 200)}`);
}
