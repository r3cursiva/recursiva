// Push in Settings › Notifications (RSVA-647): the Push card among the channels, which turns push on for this device,
// and the list of the person's devices with Send a test and Remove. What reaches push is the rules table's Push column
// (account-notifications.tsx); how the browser subscribes is lib/push.ts.
import { BellRingingIcon, DesktopIcon, DeviceMobileIcon } from "@phosphor-icons/react";
import type { NotifyPrefs, PushView } from "@rsva/protocol";
import { shortDate } from "@rsva/display/time";
import { errorText } from "@rsva/schema/util";
import { Badge } from "@rsva/ui/components/badge";
import { Button } from "@rsva/ui/components/button";
import { useEffect, useState, type ReactNode } from "react";
import { timeAgo, useNow } from "../lib/time.ts";
import { pushBlocked, pushSupport, removePushDevice, testPush, thisEndpoint, turnOnPush } from "../lib/push.ts";
import { Channel, Dot } from "./account-notifications.tsx";
import { instantSummary } from "./account-telegram.tsx";
import { notice } from "./notice.ts";
import { CredentialRow, listBox } from "./settings-fields.tsx";

/** This browser's subscription's address, read once the page opens; undefined until then. */
export function useThisEndpoint(view: PushView): [string | null | undefined, (e: string | null) => void] {
  const [endpoint, setEndpoint] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (view.key) void thisEndpoint().then(setEndpoint, () => setEndpoint(null));
  }, [view.key]);
  return [endpoint, setEndpoint];
}

/** The Push card: what this device can do, and the step that turns push on here. */
export function PushCard({ view, prefs, endpoint, onChange }: { view: PushView; prefs: NotifyPrefs; endpoint: string | null | undefined; onChange: (v: PushView, endpoint?: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const card = ({ state, status, text, action }: { state: boolean; status: string; text: ReactNode; action?: ReactNode }) => (
    <Channel icon={<BellRingingIcon />} name="Push" state={<Dot on={state} />} status={status} {...(action ? { action } : {})}>
      {text}
    </Channel>
  );
  const here = view.devices.find((d) => d.endpoint === endpoint);
  const others = view.devices.length - (here ? 1 : 0);
  const elsewhere = others ? `On ${others === 1 ? "1 other device" : `${others} other devices`}` : "Off";
  if (!view.key) return card({ state: false, status: "Not set up", text: "Push is not set up on this server yet." });
  if (here) return card({ state: true, status: others ? `This device and ${others} more` : "This device", text: `${instantSummary(prefs, "push")}.` });
  const support = pushSupport();
  if (support === "home-screen") return card({ state: false, status: elsewhere, text: "On iPhone and iPad, push comes to the app on the Home Screen: in Safari, Share › Add to Home Screen, then open recursiva from there." });
  if (support === "no") return card({ state: false, status: elsewhere, text: "This browser does not take push notifications." });
  if (pushBlocked()) return card({ state: false, status: elsewhere, text: "Notifications are blocked for this site. Allow them in the browser’s settings to turn push on." });
  const turnOn = async () => {
    setBusy(true);
    try {
      const next = await turnOnPush(view.key!);
      onChange(next, await thisEndpoint());
      notice.show("Push is on for this device");
    } catch (e) {
      notice.show(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return card({
    state: false,
    status: elsewhere,
    text: "What waits on you, on this device’s lock screen or desktop, even with the app closed.",
    action: (
      <Button variant="outline" size="sm" disabled={busy || endpoint === undefined} onClick={() => void turnOn()}>
        <BellRingingIcon />
        Turn on for this device
      </Button>
    ),
  });
}

/** The person's devices that take push: this one marked, each with Send a test and Remove. */
export function PushDevices({ view, endpoint, onChange }: { view: PushView; endpoint: string | null | undefined; onChange: (v: PushView, endpoint?: string | null) => void }) {
  const now = useNow();
  const test = (id: string, name: string) =>
    testPush(id).then(
      (r) => (onChange(r.view), notice.show(r.sent ? `Test sent to ${name}` : `${name} did not take it. Remove it and turn push on there again.`)),
      (e: unknown) => notice.show(errorText(e)),
    );
  const remove = (id: string, name: string, isThis: boolean) =>
    removePushDevice(id, isThis).then(
      (v) => (onChange(v, isThis ? null : undefined), notice.show(`${name} removed`)),
      (e: unknown) => notice.show(errorText(e)),
    );
  return (
    <div className={listBox}>
      {view.devices.map((d) => {
        const isThis = d.endpoint === endpoint;
        return (
          <CredentialRow
            key={d.id}
            icon={/iOS|Android/.test(d.name) ? <DeviceMobileIcon /> : <DesktopIcon />}
            title={d.name}
            tag={
              isThis && (
                <Badge variant="pill" className="text-ink-2">
                  This device
                </Badge>
              )
            }
            facts={`Added ${shortDate(d.createdAt)} · ${d.sentAt ? `last push ${timeAgo(d.sentAt, now)}` : "no push yet"}`}
            extra={
              <Button variant="ghost" size="sm" className="shrink-0" aria-label={`Send a test to ${d.name}`} onClick={() => void test(d.id, d.name)}>
                {/* Short on a phone, where the device's name needs the room. */}
                <span className="max-md:hidden">Send a test</span>
                <span className="md:hidden">Test</span>
              </Button>
            }
            action="Remove"
            question={
              <>
                <span className="font-semibold text-ink">Stop push to {isThis ? "this device" : d.name}?</span> Turn it on there again to get it back.
              </>
            }
            onConfirm={() => void remove(d.id, d.name, isThis)}
          />
        );
      })}
    </div>
  );
}
