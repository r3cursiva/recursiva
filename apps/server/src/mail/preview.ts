// `pnpm --filter @rsva/server mail:preview`: writes every email to dist/mail-preview as .html and .txt, to open in a
// browser. The logos come from apps/web/public, so a preview needs no server.
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { SAMPLE_ORIGIN, sampleMails } from "./samples.ts";

const out = new URL("../../dist/mail-preview/", import.meta.url);
const logos = pathToFileURL(new URL("../../../web/public", import.meta.url).pathname).href;
mkdirSync(out, { recursive: true });
const mails = sampleMails({
  person: "Robin",
  workspace: "beacon",
  passkey: "MacBook Pro",
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/142.0.0.0 Safari/537.36",
});
for (const [name, mail] of Object.entries(mails)) {
  writeFileSync(new URL(`${name}.html`, out), mail.html.replaceAll(`${SAMPLE_ORIGIN}/mail-mark`, `${logos}/mail-mark`));
  writeFileSync(new URL(`${name}.txt`, out), `Subject: ${mail.subject}\n\n${mail.text}\n`);
}
console.log(`${Object.keys(mails).length} emails in ${out.pathname}`);
