import { createSign } from "node:crypto";
import type { PlayStatus } from "@startupwinner/core";

// Google Play Developer API, read only the tracks (D17). Reading tracks needs an "edit";
// it is opened, read and deleted again, never committed, so nothing on Play changes.
// https://developers.google.com/android-publisher

const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export function parseServiceAccount(json: string): ServiceAccount {
  let account: Partial<ServiceAccount>;
  try {
    account = JSON.parse(json);
  } catch {
    throw new Error("play-service-account isn't valid JSON (paste the whole key file)");
  }
  if (!account.client_email || !account.private_key) throw new Error("play-service-account is missing client_email or private_key");
  return account as ServiceAccount;
}

/** OAuth 2.0 for service accounts: a signed assertion traded for an access token. */
export async function googleAccessToken(account: ServiceAccount, fetchImpl: typeof fetch = fetch, nowSeconds = Math.floor(Date.now() / 1000)) {
  const tokenUri = account.token_uri ?? "https://oauth2.googleapis.com/token";
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: account.client_email,
    scope: SCOPE,
    aud: tokenUri,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  })}`;
  const assertion = `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(account.private_key).toString("base64url")}`;
  const res = await fetchImpl(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) throw new Error(`Google refused the service account (${res.status})`);
  return ((await res.json()) as { access_token: string }).access_token;
}

export async function fetchPlayStatus(accessToken: string, packageName: string, fetchImpl: typeof fetch = fetch): Promise<PlayStatus> {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const base = `${API}/${encodeURIComponent(packageName)}/edits`;
  const opened = await fetchImpl(base, { method: "POST", headers });
  if (opened.status === 403) throw new Error("the service account has no access to this app in Play Console (add it under Users and permissions)");
  if (opened.status === 404) throw new Error(`no app ${packageName} in Play Console`);
  if (!opened.ok) throw new Error(`Google Play: opening a read edit failed (${opened.status})`);
  const { id } = (await opened.json()) as { id: string };
  try {
    const res = await fetchImpl(`${base}/${id}/tracks`, { headers });
    if (!res.ok) throw new Error(`Google Play: reading tracks failed (${res.status})`);
    const body = (await res.json()) as {
      tracks?: { track: string; releases?: { name?: string; versionCodes?: string[]; status: string }[] }[];
    };
    return {
      packageName,
      tracks: (body.tracks ?? []).map((t) => ({
        track: t.track,
        releases: (t.releases ?? []).map((r) => ({ name: r.name ?? null, versionCodes: r.versionCodes ?? [], status: r.status })),
      })),
    };
  } finally {
    await fetchImpl(`${base}/${id}`, { method: "DELETE", headers }).catch(() => undefined);
  }
}
