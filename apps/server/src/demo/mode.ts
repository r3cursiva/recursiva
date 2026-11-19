// Whether this server is the public demo (RSVA_DEMO=on, demo.ts), apart from demo.ts: the budgets (sync/limits.ts) read
// it, and demo.ts reaches them through the write path.
export const demoMode = process.env.RSVA_DEMO === "on";

/** The answer to an upload: the demo's files would be served to every visitor, so it takes none. */
export const NO_UPLOADS = { error: "forbidden", message: "Files cannot be uploaded in the demo." } as const;
