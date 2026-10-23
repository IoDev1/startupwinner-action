import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { promisify } from "node:util";
import { createAppStoreJwt, fetchAppStoreStatus } from "../src/app-store.ts";
import { fetchPlayStatus, googleAccessToken } from "../src/play.ts";
import { collect, send } from "../src/run.ts";

test("App Store Connect token: ES256 over header.payload, 15 minutes, right audience", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const jwt = createAppStoreJwt("KEY123", "issuer-1", pem, 1_000_000);
  const [h, p, s] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { alg: "ES256", kid: "KEY123", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(p, "base64url").toString()), { iss: "issuer-1", iat: 1_000_000, exp: 1_000_900, aud: "appstoreconnect-v1" });
  assert.ok(createVerify("SHA256").update(`${h}.${p}`).verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")));
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test("App Store status: newest build, valid build, newest version state, live", async () => {
  const impl = (async (url: string) => {
    const u = new URL(url);
    if (u.pathname === "/v1/apps") return json({ data: [{ id: "app1", attributes: { name: "Blumour", bundleId: "com.blumour.app" } }] });
    if (u.pathname === "/v1/builds") {
      return json({ data: [
        { id: "b5", attributes: { version: "5", processingState: "PROCESSING", uploadedDate: "2026-10-20T10:00:00Z" } },
        { id: "b4", attributes: { version: "4", processingState: "VALID", uploadedDate: "2026-10-16T10:00:00Z" } },
      ] });
    }
    return json({ data: [
      { id: "v0", attributes: { versionString: "0.9.0", appStoreState: "READY_FOR_SALE", createdDate: "2026-09-01T00:00:00Z" } },
      { id: "v1", attributes: { versionString: "1.0.0", appVersionState: "WAITING_FOR_REVIEW", createdDate: "2026-10-18T00:00:00Z" } },
    ] });
  }) as unknown as typeof fetch;
  const s = await fetchAppStoreStatus("jwt", "com.blumour.app", impl);
  assert.deepEqual(s, {
    bundleId: "com.blumour.app",
    appName: "Blumour",
    latestBuild: { version: "5", processingState: "PROCESSING", uploadedAt: "2026-10-20T10:00:00Z" },
    hasValidBuild: true,
    latestVersion: { versionString: "1.0.0", state: "WAITING_FOR_REVIEW" },
    isLive: true,
  });
});

test("Google Play: the read edit is always deleted, even when reading fails", async () => {
  const calls: string[] = [];
  const make = (tracksStatus: number) =>
    (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname.split("/applications/")[1]}`);
      if (init?.method === "POST") return json({ id: "e1" });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return json({ tracks: [{ track: "internal", releases: [{ name: "1.0.0", versionCodes: ["6"], status: "completed" }] }] }, tracksStatus);
    }) as unknown as typeof fetch;

  const s = await fetchPlayStatus("tok", "com.blumour.app", make(200));
  assert.deepEqual(s.tracks, [{ track: "internal", releases: [{ name: "1.0.0", versionCodes: ["6"], status: "completed" }] }]);
  assert.deepEqual(calls, ["POST com.blumour.app/edits", "GET com.blumour.app/edits/e1/tracks", "DELETE com.blumour.app/edits/e1"]);
  assert.ok(!calls.some((c) => c.includes(":commit")), "never commits");

  calls.length = 0;
  await assert.rejects(fetchPlayStatus("tok", "com.blumour.app", make(500)), /reading tracks failed/);
  assert.equal(calls.at(-1), "DELETE com.blumour.app/edits/e1");
});

test("Google service-account token: signed assertion posted to the token URI", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let body = "";
  const impl = (async (_url: string, init: RequestInit) => {
    body = String(init.body);
    return json({ access_token: "ya29" });
  }) as unknown as typeof fetch;
  const account = { client_email: "sw@p.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
  assert.equal(await googleAccessToken(account, impl, 1_000_000), "ya29");
  const params = new URLSearchParams(body);
  assert.equal(params.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  const claims = JSON.parse(Buffer.from(params.get("assertion")!.split(".")[1], "base64url").toString());
  assert.equal(claims.scope, "https://www.googleapis.com/auth/androidpublisher");
});

test("collect: each source fails on its own, half-configured sources are reported, keys never in the report", async () => {
  const { report } = await collect(
    { stripeKey: "sk_live_full_key", appStoreKeyId: "K", playServiceAccount: "not json" },
    { deploy: { android: { package: "com.blumour.app" } } } as never,
    (async () => json({})) as unknown as typeof fetch,
  );
  assert.match(report.errors!.stripe!, /full secret key/);
  assert.match(report.errors!.app_store!, /needs all three/);
  assert.match(report.errors!.play!, /valid JSON/);
  assert.ok(!JSON.stringify(report).includes("sk_live_full_key"));

  const { report: empty } = await collect({}, null, (async () => json({})) as unknown as typeof fetch);
  assert.deepEqual(empty, { action_version: "1.1.0" });
});

test("send: https only (or localhost), bearer token, failures are errors", async () => {
  await assert.rejects(send("http://startupwinner.example", "swi_x", {}), /https/);
  let auth = "";
  const ok = (async (_u: URL, init: RequestInit) => {
    auth = String((init.headers as Record<string, string>).Authorization);
    return json({ ok: true });
  }) as unknown as typeof fetch;
  await send("https://startupwinner.example", "swi_x", {}, ok);
  assert.equal(auth, "Bearer swi_x");
  await assert.rejects(send("https://s.example", "swi_x", {}, (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch), /refused/);
});

test("the built dist/index.mjs runs like GitHub runs it and posts a report", async () => {
  let received: { auth?: string; body?: unknown } = {};
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      received = { auth: req.headers.authorization, body: JSON.parse(data) };
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [new URL("../dist/index.mjs", import.meta.url).pathname], {
      env: { "INPUT_TOKEN": "swi_test", "INPUT_API-URL": `http://localhost:${port}`, GITHUB_WORKSPACE: "/nonexistent" },
    });
    assert.match(stdout, /Sent the results/);
    assert.equal(received.auth, "Bearer swi_test");
    assert.deepEqual(received.body, { action_version: "1.1.0" });
  } finally {
    server.close();
  }
});

test("dist/index.mjs is built from the current source (run `pnpm build` if not)", async () => {
  const { build } = await import("esbuild");
  const { readFile } = await import("node:fs/promises");
  const { options } = await import("../scripts/build.ts");
  const fresh = await build({ ...options, write: false });
  const committed = await readFile(new URL("../dist/index.mjs", import.meta.url), "utf8");
  assert.equal(fresh.outputFiles[0].text, committed);
});

test("RevenueCat: both inputs needed; results land in the report, keys never do", async () => {
  const half = await collect({ revenueCatKey: "sk_rc" }, null, (async () => new Response("{}")) as unknown as typeof fetch);
  assert.match(half.report.errors?.revenuecat ?? "", /needs both/);
  const fake = (async () =>
    new Response(JSON.stringify({ currency: "EUR", metrics: [{ id: "mrr", name: "MRR", unit: "€", period: "P28D", value: 99 }] }))) as unknown as typeof fetch;
  const { report } = await collect({ revenueCatKey: "sk_rc_secret", revenueCatProjectId: "proj1", revenueCatCurrency: "EUR" }, null, fake);
  assert.deepEqual(report.revenuecat, { currency: "EUR", metrics: [{ id: "mrr", name: "MRR", unit: "€", period: "P28D", value: 99 }] });
  assert.ok(!JSON.stringify(report).includes("sk_rc_secret"));
});
