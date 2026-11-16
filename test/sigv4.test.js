// #188: SigV4 helper: AWS test-suite vectors, inbound verify, re-sign.
import test from "node:test";
import assert from "node:assert/strict";
import { canonicalQuery, canonicalUri, computeSignature, credentialsFromEnv, parseAuthorization, signRequest, uriEncode, verifyRequest, amzDateOf } from "../src/sigv4.js";

const SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const base = { secretAccessKey: SECRET, amzDate: "20150830T123600Z", region: "us-east-1", service: "service", payloadHash: EMPTY };
const vh = { host: "example.amazonaws.com", "x-amz-date": "20150830T123600Z" };
const CREDS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: SECRET };

test("reproduces AWS SigV4 test-suite signatures", () => {
  const sig = (o) => computeSignature({ ...base, headers: vh, signedHeaders: ["host", "x-amz-date"], ...o }).signature;
  assert.equal(sig({ method: "GET", path: "/" }), "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"); // get-vanilla
  assert.equal(sig({ method: "POST", path: "/" }), "5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b"); // post-vanilla
  assert.equal(sig({ method: "GET", path: "/", search: "?Param2=value2&Param1=value1" }), "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500"); // get-vanilla-query-order-key-case
  // IAM ListUsers example from the SigV4 documentation.
  assert.equal(computeSignature({ ...base, service: "iam", method: "GET", path: "/", search: "?Action=ListUsers&Version=2010-05-08",
    headers: { host: "iam.amazonaws.com", "x-amz-date": "20150830T123600Z", "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
    signedHeaders: ["content-type", "host", "x-amz-date"] }).signature, "5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7");
});

test("canonical URI double-encodes path segments; query is sorted and encoded", () => {
  assert.equal(canonicalUri("/model/us.anthropic.claude-sonnet-4-5-20250929-v1%3A0/invoke"), "/model/us.anthropic.claude-sonnet-4-5-20250929-v1%253A0/invoke");
  assert.equal(canonicalUri("/a%20b", { doubleEncode: false }), "/a%20b");
  assert.equal(canonicalUri(""), "/");
  assert.equal(canonicalQuery("?b=2&a=1&a=0&c"), "a=0&a=1&b=2&c=");
  assert.equal(canonicalQuery(""), "");
  assert.equal(uriEncode("a!*'()"), "a%21%2A%27%28%29");
});

test("signRequest output verifies; tampering, wrong key or wrong body fail", () => {
  const body = '{"max_tokens":10}';
  const signed = signRequest({ method: "POST", host: "127.0.0.1:9", path: "/bedrock/model/x%3A0/invoke", headers: { "content-type": "application/json" }, body,
    credentials: { ...CREDS, sessionToken: "TOKEN" }, region: "us-east-1", service: "bedrock", extraSigned: ["content-type"], now: new Date("2026-11-16T00:00:00Z") });
  assert.equal(signed["x-amz-security-token"], "TOKEN");
  const headers = { ...signed, "content-type": "application/json" };
  const ok = verifyRequest({ method: "POST", path: "/bedrock/model/x%3A0/invoke", headers, body, credentials: CREDS });
  assert.deepEqual(ok, { ok: true, region: "us-east-1", service: "bedrock" });
  const auth = parseAuthorization(headers.authorization);
  assert.deepEqual(auth.signedHeaders, ["content-type", "host", "x-amz-content-sha256", "x-amz-date", "x-amz-security-token"]);
  const tampered = { ...headers, authorization: headers.authorization.replace(/Signature=(.)/, (m, c) => `Signature=${c === "0" ? "1" : "0"}`) };
  assert.equal(verifyRequest({ method: "POST", path: "/bedrock/model/x%3A0/invoke", headers: tampered, body, credentials: CREDS }).reason, "signature_mismatch");
  assert.equal(verifyRequest({ method: "POST", path: "/bedrock/model/x%3A0/invoke", headers, body: "{}", credentials: CREDS }).reason, "payload_hash_mismatch");
  assert.equal(verifyRequest({ method: "POST", path: "/bedrock/model/y/invoke", headers, body, credentials: CREDS }).reason, "signature_mismatch");
  assert.equal(verifyRequest({ method: "POST", path: "/", headers, body, credentials: { ...CREDS, accessKeyId: "OTHER" } }).reason, "access_key_mismatch");
  assert.equal(verifyRequest({ method: "POST", path: "/", headers: { ...headers, "x-amz-date": "20990101T000000Z" }, body, credentials: CREDS }).reason, "date_mismatch");
  assert.equal(verifyRequest({ method: "POST", path: "/", headers: { authorization: "Bearer x" }, body, credentials: CREDS }).reason, "malformed_authorization");
  const noHost = { ...headers, authorization: headers.authorization.replace("host;", "") };
  assert.equal(verifyRequest({ method: "POST", path: "/", headers: noHost, body, credentials: CREDS }).reason, "host_unsigned");
});

test("parseAuthorization rejects malformed headers; credentialsFromEnv needs both static keys", () => {
  assert.equal(parseAuthorization(undefined), null);
  assert.equal(parseAuthorization("AWS4-HMAC-SHA256 Credential=a/b/c, SignedHeaders=host, Signature=" + "0".repeat(64)), null);
  assert.equal(parseAuthorization("AWS4-HMAC-SHA256 Credential=a/20150830/us-east-1/s/aws4_request, SignedHeaders=host, Signature=zz"), null);
  assert.equal(credentialsFromEnv({ AWS_ACCESS_KEY_ID: "a" }), null);
  assert.deepEqual(credentialsFromEnv({ AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" }), { accessKeyId: "a", secretAccessKey: "b" });
  assert.equal(credentialsFromEnv({ AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b", AWS_SESSION_TOKEN: "t" }).sessionToken, "t");
  assert.equal(amzDateOf(new Date("2015-08-30T12:36:00.123Z")), "20150830T123600Z");
});
