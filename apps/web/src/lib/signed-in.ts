// Sign-in checks the startup code needs without loading the passkey code (passkeys.ts). rsva_in=1 is the cookie the
// server sets beside the HttpOnly session cookie: a hint, readable before any request, that this browser has a session
// (auth.ts).
export const signedIn = (): boolean => /(?:^|;\s*)rsva_in=1(?:;|$)/.test(document.cookie);

/** Drops the hint locally, for when the server cannot be told (offline sign-out). */
export const forgetSignedIn = (): void => void (document.cookie = "rsva_in=; Path=/; Max-Age=0");

/**
 * The server answered 401 to a signed-in page: the session ended elsewhere (signed out, expired, or its person has no
 * workspace and no invite left). The page starts over on the sign-in screen; local copies stay for the same person's
 * next sign-in (auth.ts).
 */
export function sessionEnded(): void {
  forgetSignedIn();
  location.reload();
}

/** The browser can hold passkeys (the code for them, passkeys.ts, loads on demand). */
export const passkeysSupported = (): boolean => typeof PublicKeyCredential !== "undefined" && !!navigator.credentials;

/** The person closed the passkey dialog or another request replaced it: nothing to report. */
export const dismissed = (e: unknown): boolean => e instanceof DOMException && (e.name === "AbortError" || e.name === "NotAllowedError");
