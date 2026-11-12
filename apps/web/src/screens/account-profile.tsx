// Settings › Profile (PLNR-194): who the person is to others, the same in every workspace: their picture
// (account-picture.tsx, PLNR-244), name and address. The time they keep is on Preferences (account-preferences.tsx), how
// recursiva looks on Appearance (theme-picker.tsx). There is no artboard for the page, only its place in the settings
// navigation (Account › Profile on the Notifications and Appearance artboards); it is built from the settings' parts,
// saving as it changes like General.
//
// The address changes in a dialog of its own (email-change.tsx): the new one is checked with a code first.
import { Button } from "@rsva/ui/components/button";
import { InputGroup } from "@rsva/ui/components/input-group";
import { SettingRow, SettingsSection } from "@rsva/ui/components/settings";
import { cn } from "@rsva/ui/lib/utils";
import { reaction } from "mobx";
import { observer } from "mobx-react-lite";
import { useEffect, useState } from "react";
import { account } from "../account.ts";
import { AccountPicture } from "./account-picture.tsx";
import { store } from "../store.ts";
import { saving } from "./save-status.tsx";
import { EmailChange } from "./email-change.tsx";
import { CommitInput, fieldClass } from "./settings-fields.tsx";


export const AccountProfile = observer(function AccountProfile() {
  // Another device may have changed them since this one saved its copy.
  useEffect(() => void account.refresh(), []);
  // The field shows the name sent until this workspace's log brings it back, or brings another one.
  useEffect(
    () =>
      reaction(
        () => store.me?.name,
        () => account.settled(),
      ),
    [],
  );
  const [changing, setChanging] = useState(false);
  const me = store.me;
  if (!me) return <p className="m-0 text-label text-ink-3">Loading…</p>;
  const name = account.pendingName ?? me.name;
  return (
    <SettingsSection id="identity" title="Identity">
      <SettingRow label="Picture" hint="Beside your name on issues, comments and mentions, in every workspace.">
        <AccountPicture />
      </SettingRow>
      <SettingRow label="Name" hint="On your issues, comments and mentions, in every workspace." htmlFor="profile-name">
        <CommitInput id="profile-name" value={name} className="max-w-[420px]" onCommit={(v) => saving(account.rename(v))} />
      </SettingRow>
      <SettingRow label="Email" hint="You sign in with it; codes, notifications and security emails go here.">
        <div className="flex max-w-[420px] items-center gap-2">
          <InputGroup className={cn(fieldClass, "flex-1 bg-transparent dark:bg-transparent")}>
            <span className="truncate">{me.email}</span>
          </InputGroup>
          <Button type="button" variant="outline" onClick={() => setChanging(true)}>
            Change
          </Button>
        </div>
        <EmailChange open={changing} onClose={() => setChanging(false)} />
      </SettingRow>
    </SettingsSection>
  );
});
