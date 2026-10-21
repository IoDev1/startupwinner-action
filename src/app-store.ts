import { createSign } from "node:crypto";
import type { AppStoreStatus } from "@startupwinner/core";

// App Store Connect API, read only what the dashboard shows (D17).
// https://developer.apple.com/documentation/appstoreconnectapi

const API = "https://api.appstoreconnect.apple.com";

/** The API's ES256 JSON Web Token (Apple refuses lifetimes over 20 minutes). */
export function createAppStoreJwt(keyId: string, issuerId: string, privateKeyPem: string, nowSeconds = Math.floor(Date.now() / 1000)) {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = b64({ alg: "ES256", kid: keyId, typ: "JWT" });
  const payload = b64({ iss: issuerId, iat: nowSeconds, exp: nowSeconds + 15 * 60, aud: "appstoreconnect-v1" });
  const signature = createSign("SHA256")
    .update(`${header}.${payload}`)
    .sign({ key: privateKeyPem, dsaEncoding: "ieee-p1363" })
    .toString("base64url");
  return `${header}.${payload}.${signature}`;
}

interface Resource<T> {
  id: string;
  attributes: T;
}

async function get<T>(jwt: string, path: string, fetchImpl: typeof fetch) {
  const res = await fetchImpl(`${API}${path}`, { headers: { Authorization: `Bearer ${jwt}` } });
  if (res.status === 401) throw new Error("App Store Connect refused the key (check key id, issuer id and the .p8 file)");
  if (res.status === 403) throw new Error("the App Store Connect key's role can't read this (use the Developer role)");
  if (!res.ok) throw new Error(`App Store Connect ${path.split("?")[0]} failed (${res.status})`);
  return ((await res.json()) as { data: Resource<T>[] }).data;
}

const LIVE = new Set(["READY_FOR_SALE", "READY_FOR_DISTRIBUTION"]);

export async function fetchAppStoreStatus(jwt: string, bundleId: string, fetchImpl: typeof fetch = fetch): Promise<AppStoreStatus> {
  const [app] = await get<{ name: string; bundleId: string }>(
    jwt,
    `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&fields[apps]=name,bundleId&limit=1`,
    fetchImpl,
  );
  if (!app) throw new Error(`no app with bundle id ${bundleId} in App Store Connect`);

  const [builds, versions] = await Promise.all([
    get<{ version: string; processingState: string; uploadedDate: string }>(
      jwt,
      `/v1/builds?filter[app]=${app.id}&sort=-uploadedDate&limit=20&fields[builds]=version,processingState,uploadedDate`,
      fetchImpl,
    ),
    get<{ versionString: string; appStoreState?: string; appVersionState?: string; createdDate: string }>(
      jwt,
      `/v1/apps/${app.id}/appStoreVersions?limit=20&fields[appStoreVersions]=versionString,appStoreState,appVersionState,createdDate`,
      fetchImpl,
    ),
  ]);

  const state = (v: (typeof versions)[number]) => v.attributes.appVersionState ?? v.attributes.appStoreState ?? "UNKNOWN";
  const newest = versions.toSorted((a, b) => Date.parse(b.attributes.createdDate) - Date.parse(a.attributes.createdDate))[0];
  return {
    bundleId,
    appName: app.attributes.name ?? null,
    latestBuild: builds[0]
      ? { version: builds[0].attributes.version, processingState: builds[0].attributes.processingState, uploadedAt: builds[0].attributes.uploadedDate }
      : null,
    hasValidBuild: builds.some((b) => b.attributes.processingState === "VALID"),
    latestVersion: newest ? { versionString: newest.attributes.versionString, state: state(newest) } : null,
    isLive: versions.some((v) => LIVE.has(state(v))),
  };
}
