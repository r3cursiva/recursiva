// The person's own settings (Settings › Profile, PLNR-194): the time zone and the first day of the week, kept on the
// server for every device and saved here so the calendars draw the right week at start without a request. Their name
// is the pool's (store.me): a new one comes back as a User action in every workspace (auth/account.ts on the server).
//
// A device that has never heard of them takes them from the workspace snapshot's headers (PLNR-210), which a cold start
// fetches anyway; only one that starts without a snapshot (a copy saved before them) or from a server that does not send
// them asks GET /auth/me. A person without a time zone gets this browser's, so the server has one for the times it keeps
// for them. Changes show at once; when several are on their way, only the answer to the last one counts, and a refusal
// of the last one puts back what the server holds.
import { ACCOUNT_DEFAULTS, WEEK_STARTS, type AccountMe, type AccountPatch, type AccountSettings } from "@rsva/protocol";
import { makeAutoObservable, runInAction } from "mobx";
import { call } from "./lib/api.ts";
import { readLocal, writeLocal } from "./lib/local-storage.ts";
import { sessionEnded } from "./lib/signed-in.ts";

const KEY = "rsva:account";

/** This browser's zone: what a person without one is given. */
export const deviceTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

function saved(): AccountSettings | null {
  const v = readLocal(KEY) as Partial<AccountSettings> | null;
  return v && typeof v === "object" && WEEK_STARTS.includes(v.weekStart!) ? { ...ACCOUNT_DEFAULTS, ...v } : null;
}

class Account {
  settings: AccountSettings = saved() ?? ACCOUNT_DEFAULTS;
  /** A name sent and not yet back from the sync log: the field shows it meanwhile. */
  pendingName: string | null = null;
  private asked: Promise<void> | null = null;
  /** What the server holds has been seen on this device: saved, from a snapshot, or from /auth/me. */
  private known = saved() !== null;
  /** Number of the last change sent, and how many are still on their way. */
  private sent = 0;
  private waiting = 0;
  /** The browser's zone was offered this page: a refusal is not tried again and again. */
  private filled = false;
  /** Who else reads the answer to GET /auth/me: the workspaces store takes whether the viewer may create workspaces. */
  onMe: ((me: AccountMe) => void) | null = null;

  constructor() {
    makeAutoObservable<Account, "asked" | "known" | "sent" | "waiting" | "filled">(this, { asked: false, known: false, sent: false, waiting: false, filled: false, onMe: false });
  }

  private keep(s: AccountSettings): void {
    this.settings = s;
    writeLocal(KEY, s);
  }

  /** The server's settings as of change number `at`: kept unless a change made since is on its way; no zone gets this browser's. */
  private async take(s: AccountSettings, at: number): Promise<void> {
    this.known = true;
    // A snapshot's settings leave My work's sections out (undefined): the copy here stays.
    if (this.sent === at && !this.waiting) runInAction(() => this.keep(s.myWork === undefined ? { ...s, myWork: this.settings.myWork ?? null } : s));
    if (!s.timeZone && !this.filled) {
      this.filled = true;
      await this.update({ timeZone: deviceTimeZone() }).catch((e: unknown) => console.warn("rsva account: time zone not set:", e));
    }
  }

  /** The settings a workspace snapshot carried (store.ts). */
  fromSnapshot(s: AccountSettings): void {
    void this.take(s, this.sent);
  }

  /** GET /auth/me once a page: the workspace menus and the Profile page call it, and a start without the settings. */
  refresh(): Promise<void> {
    const at = this.sent;
    return (this.asked ??= fetch("/auth/me")
      .then(async (r) => {
        if (r.status === 401) return sessionEnded();
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const me = (await r.json()) as AccountMe;
        this.onMe?.(me);
        // A change made while this was on its way is newer than the answer.
        await this.take(me.settings, at);
      })
      .catch((e: unknown) => {
        this.asked = null;
        console.warn("rsva account:", e);
      }));
  }

  /** After the workspace has loaded: asks the server once if neither this device nor the snapshot had the settings. */
  startup(): void {
    if (!this.known) void this.refresh();
  }

  /** Shown at once; if the server refuses the last change, what it holds comes back and the reason is thrown. */
  async update(patch: Omit<AccountPatch, "name" | "avatar">): Promise<void> {
    const n = ++this.sent;
    this.waiting++;
    this.keep({ ...this.settings, ...patch });
    let answer: AccountSettings;
    try {
      answer = (await call<{ settings: AccountSettings }>("PATCH", "/auth/me", patch)).settings;
    } catch (e) {
      runInAction(() => this.waiting--);
      if (n === this.sent) {
        this.asked = null;
        void this.refresh();
      }
      throw e;
    }
    runInAction(() => {
      this.waiting--;
      if (n === this.sent) this.keep(answer);
    });
  }

  /** The name reaches every workspace through the log; until it does here, `pendingName` stands in. */
  async rename(name: string): Promise<void> {
    this.pendingName = name;
    try {
      await call("PATCH", "/auth/me", { name } satisfies AccountPatch);
    } catch (e) {
      runInAction(() => (this.pendingName = null));
      throw e;
    }
  }

  /**
   * A new picture (PLNR-244), or none: it reaches every workspace through the log, as a name does, and the avatars follow
   * the pool. Resolves with its hash.
   */
  async setPicture(picture: Blob | null): Promise<string | null> {
    const r = picture ? await call<{ picture: string }>("PUT", "/auth/me/picture", picture) : await call<{ picture: null }>("DELETE", "/auth/me/picture");
    return r.picture;
  }

  /** A creature for the avatar (PLNR-366), or null for the name's own: it reaches every workspace as a name does. */
  async setAvatar(avatar: string | null): Promise<void> {
    await call("PATCH", "/auth/me", { avatar } satisfies AccountPatch);
  }

  /** The pool has the name now (or another one arrived): the field follows the pool again. */
  settled(): void {
    this.pendingName = null;
  }
}

export const account = new Account();
