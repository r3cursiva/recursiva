// The macOS Keychain through `security`: tokens and the terminal's session. A secret goes in on stdin (`security -i`),
// never in argv, where any process of the Mac could read it.
import { execFile } from "node:child_process";

const run = (args: string[], input?: string) =>
  new Promise<string>((resolve, reject) => {
    const child = execFile("security", args, (err, out) => (err ? reject(err) : resolve(out.trim())));
    if (input !== undefined) child.stdin!.end(input);
  });

/** The secret kept under the service; rejects when there is none. */
export const readSecret = (service: string): Promise<string> => run(["find-generic-password", "-s", service, "-w"]);

/** Keeps a secret under the service and account, replacing one there. Only URL-safe secrets: they need no quoting. */
export async function writeSecret(service: string, account: string, secret: string): Promise<void> {
  if (!/^[\w-]+$/.test(secret) || !/^[\w.@+-]+$/.test(account) || !/^[\w-]+$/.test(service)) throw new Error("keychain: a secret, account or service it cannot keep");
  await run(["-i"], `add-generic-password -U -s ${service} -a ${account} -w ${secret}\n`);
  // `security -i` exits 0 whatever its command did: the secret read back says whether it is kept.
  if ((await readSecret(service).catch(() => null)) !== secret) throw new Error(`keychain: could not keep the secret under ${service}`);
}

/**
 * Forgets the service's secrets; false when there was none. `security` deletes one item a call, and a service may hold
 * several (one per account, as login kept them before it removed the old one first): each goes.
 */
export async function removeSecret(service: string): Promise<boolean> {
  let removed = false;
  // Bounded: a `security` that reports a deletion it did not make must not spin forever.
  for (let i = 0; i < 16; i++) {
    if (!(await run(["delete-generic-password", "-s", service]).then(() => true, () => false))) break;
    removed = true;
  }
  return removed;
}
