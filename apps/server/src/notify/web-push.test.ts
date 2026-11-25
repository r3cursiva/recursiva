import assert from "node:assert/strict";
import { createECDH, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { test } from "node:test";
import { encrypt, vapidAuth, vapidKey } from "./web-push.ts";

const b = (s: string) => Buffer.from(s.replace(/\s+/g, ""), "base64url");

// RFC 8291, section 5 and appendix A: the example's keys, salt and secret, and the body they make.
test("the encryption gives RFC 8291's example body", () => {
  const sender = createECDH("prime256v1");
  sender.setPrivateKey(b("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"));
  const body = encrypt(
    b("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24"),
    b("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV- JvLexhqUzORcx aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
    b("BTBZMqHH6r4Tts7J_aSIgg"),
    sender,
    b("DGv6ra1nlYgDCS1FRnbzlw"),
  );
  const header = b("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8");
  const sealed = b("8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs bI_0LpXMuGvnzQ");
  assert.equal(body.toString("base64url"), Buffer.concat([header, sealed]).toString("base64url"));
});

test("the VAPID header is a JWT for the push service's origin, signed by the server's key", () => {
  const jwk = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" });
  const publicKey = Buffer.concat([Buffer.of(4), b(jwk.x!), b(jwk.y!)]).toString("base64url");
  const key = vapidKey(publicKey, jwk.d!);
  const now = Date.parse("2026-11-26T10:00:00Z");
  const header = vapidAuth("https://web.push.apple.com/QGuQyavXutnMH8?x=1", key, publicKey, "https://app.example.test", now);
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
  assert.equal(k, publicKey);
  const [head, claims, signature] = jwt!.split(".");
  assert.deepEqual(JSON.parse(b(claims!).toString()), { aud: "https://web.push.apple.com", exp: now / 1000 + 12 * 3600, sub: "https://app.example.test" });
  assert.ok(verify("sha256", Buffer.from(`${head}.${claims}`), { key: createPublicKey(key), dsaEncoding: "ieee-p1363" }, b(signature!)));
});

test("keys of the wrong size are refused", () => {
  assert.throws(() => vapidKey("BAAA", "AAAA"), /VAPID keys/);
});
