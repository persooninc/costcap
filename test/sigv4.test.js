// #188: SigV4 helper (AWS published test-suite vectors, inbound verify, re-sign).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { awsCredentials, canonicalPath, canonicalQuery, isSigV4, parseAuthorization, signRequest, signature, uriEncode, verifyRequest, amzDateOf } from "../src/sigv4.js";

// AWS documentation example credentials (not a live key).
const SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const CREDS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: SECRET };
const EMPTY = createHash("sha256").update("").digest("hex");
const vector = { amzDate: "20150830T123600Z", region: "us-east-1", service: "service", secretAccessKey: SECRET, payloadHash: EMPTY,
  signedHeaders: ["host", "x-amz-date"], headers: { host: "example.amazonaws.com", "x-amz-date": "20150830T123600Z" } };

test("AWS sig-v4 test suite: get-vanilla, post-vanilla, get-vanilla-query-order-key-case", () => {
  assert.equal(signature({ ...vector, method: "GET", path: "/" }), "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  assert.equal(signature({ ...vector, method: "POST", path: "/" }), "5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b");
  assert.equal(signature({ ...vector, method: "GET", path: "/", search: "?Param2=value2&Param1=value1" }), "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500");
});

test("canonicalisation: segments are encoded again, query pairs sorted, empty path is /", () => {
  assert.equal(canonicalPath("/model/us.anthropic.claude-v1%3A0/invoke"), "/model/us.anthropic.claude-v1%253A0/invoke");
  assert.equal(canonicalPath(""), "/");
  assert.equal(canonicalQuery("?b=2&a=1&a=0&flag"), "a=0&a=1&b=2&flag=");
  assert.equal(canonicalQuery(""), "");
  assert.equal(uriEncode("a b/é", true), "a%20b/%C3%A9");
});

test("parseAuthorization accepts well-formed SigV4 headers only", () => {
  const h = "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/bedrock/aws4_request, SignedHeaders=host;x-amz-date, Signature=" + "a".repeat(64);
  assert.deepEqual(parseAuthorization(h), { accessKeyId: "AKIDEXAMPLE", date: "20150830", region: "us-east-1", service: "bedrock", signedHeaders: ["host", "x-amz-date"], signature: "a".repeat(64) });
  assert.equal(parseAuthorization("Bearer x"), null);
  assert.equal(parseAuthorization(h.replace("aws4_request", "nope")), null);
  assert.equal(parseAuthorization(h.replace("a".repeat(64), "zz")), null);
  assert.equal(isSigV4(h), true);
  assert.equal(isSigV4("Bearer x"), false);
});

const signedFor = (host, body = "{}", creds = CREDS, path = "/bedrock/model/m/invoke") =>
  signRequest({ method: "POST", path, headers: { "content-type": "application/json" }, body, host, region: "us-east-1", service: "bedrock" }, creds, new Date("2026-11-16T12:00:00Z"));

test("verifyRequest: a valid signature passes; tampering, wrong key and missing creds fail", () => {
  const body = '{"max_tokens":5}';
  const headers = signedFor("127.0.0.1:9", body);
  const req = { method: "POST", path: "/bedrock/model/m/invoke", search: "", headers, body };
  assert.deepEqual(verifyRequest(req, CREDS), { ok: true, region: "us-east-1", service: "bedrock" });
  assert.equal(verifyRequest({ ...req, body: '{"max_tokens":6}' }, CREDS).reason, "signature_mismatch");
  assert.equal(verifyRequest({ ...req, path: "/bedrock/model/n/invoke" }, CREDS).reason, "signature_mismatch");
  assert.equal(verifyRequest({ ...req, headers: { ...headers, host: "evil:1" } }, CREDS).reason, "signature_mismatch");
  assert.equal(verifyRequest(req, { ...CREDS, secretAccessKey: "other" }).reason, "signature_mismatch");
  assert.equal(verifyRequest(req, { ...CREDS, accessKeyId: "AKIDOTHER" }).reason, "access_key_mismatch");
  assert.equal(verifyRequest(req, null).reason, "credentials_unavailable");
  assert.equal(verifyRequest({ ...req, headers: { ...headers, "x-amz-date": "20991231T000000Z" } }, CREDS).reason, "bad_date");
  assert.equal(verifyRequest({ ...req, headers: { ...headers, authorization: "Bearer x" } }, CREDS).reason, "malformed_authorization");
  const unsignedHost = headers.authorization.replace("SignedHeaders=content-type;host;x-amz-date", "SignedHeaders=content-type;x-amz-date");
  assert.equal(verifyRequest({ ...req, headers: { ...headers, authorization: unsignedHost } }, CREDS).reason, "host_unsigned");
});

test("signRequest re-signs for another host with a session token and never leaks the secret", () => {
  const creds = { ...CREDS, sessionToken: "SESSIONTOKEN" };
  const inbound = signedFor("127.0.0.1:9", "{}", creds);
  const out = signRequest({ method: "POST", path: "/model/m/invoke", headers: inbound, body: "{}", host: "bedrock-runtime.eu-west-1.amazonaws.com", region: "eu-west-1", service: "bedrock" }, creds);
  assert.equal(out.host, "bedrock-runtime.eu-west-1.amazonaws.com");
  assert.equal(out["x-amz-security-token"], "SESSIONTOKEN");
  assert.match(out.authorization, /SignedHeaders=content-type;host;x-amz-date;x-amz-security-token,/);
  assert.equal(verifyRequest({ method: "POST", path: "/model/m/invoke", headers: out, body: "{}" }, creds).ok, true);
  assert.ok(!JSON.stringify(out).includes(SECRET));
  const withHash = signRequest({ method: "POST", path: "/", headers: { "x-amz-content-sha256": EMPTY }, host: "h", region: "r", service: "s" }, CREDS);
  assert.match(withHash.authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date,/);
  assert.match(amzDateOf(new Date("2026-01-02T03:04:05.678Z")), /^20260102T030405Z$/);
});

test("awsCredentials reads static creds only", () => {
  assert.equal(awsCredentials({}), null);
  assert.equal(awsCredentials({ AWS_ACCESS_KEY_ID: "a" }), null);
  assert.deepEqual(awsCredentials({ AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" }), { accessKeyId: "a", secretAccessKey: "b" });
  assert.deepEqual(awsCredentials({ AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b", AWS_SESSION_TOKEN: "c" }), { accessKeyId: "a", secretAccessKey: "b", sessionToken: "c" });
});
