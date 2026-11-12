// Controls the settings screens repeat: a name field that saves itself, the inline "are you sure" under a row, a
// credential's row with its way out, the Only people switch of a state or a label, a row of a box of choices, and a
// secret shown once.
import { CopyIcon, LockSimpleIcon, TrashIcon } from "@phosphor-icons/react";
import { NAME_MAX, cleanName } from "@rsva/schema/models";
import { Button } from "@rsva/ui/components/button";
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@rsva/ui/components/dialog";
import { Input } from "@rsva/ui/components/input";
import { Label } from "@rsva/ui/components/label";
import { Spinner } from "@rsva/ui/components/spinner";
import { Hint } from "@rsva/ui/components/tooltip";
import { cn } from "@rsva/ui/lib/utils";
import { useEffect, useState, type ReactNode } from "react";
import { ErrorLine } from "./action.tsx";
import { notice, toClipboard } from "./notice.ts";

/** The box around a settings list's rows. */
export const listBox = "overflow-hidden rounded-(--float-radius) border bg-panel";

/** The ledger's text field: 32px, on the field color, the control border. */
export const fieldClass =
  "h-8 w-full rounded-md border border-control-border bg-field px-2.5 text-[13.5px] outline-none max-md:h-11 max-md:rounded-lg max-md:px-3 max-md:text-base transition-colors duration-120 placeholder:text-ink-3 focus-visible:border-ink-3 focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-signal-text";

/** fieldClass for the catalog Input: also takes back what Input sets under `md:` and `dark:`, where fieldClass has no say. */
export const inputFieldClass = `${fieldClass} py-0 md:text-[13.5px] dark:bg-field aria-invalid:ring-0 dark:aria-invalid:border-signal-text`;

/**
 * A name field that saves on Enter or when it loses focus, as Linear's settings do: no Save button. Esc puts back the
 * stored value. What it saves is cleaned as the server stores names (cleanName); nothing visible left is not saved. While the field is not being edited it follows the stored value, so a
 * change from another tab or person shows up.
 */
export function CommitInput({
  value,
  onCommit,
  inline,
  className,
  ...props
}: {
  value: string;
  onCommit: (value: string) => void;
  /** A row's name: looks like text until hovered or focused. */
  inline?: boolean;
  className?: string;
} & Omit<React.ComponentProps<"input">, "value" | "onChange" | "className">) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const v = draft === null ? "" : cleanName(draft);
    setDraft(null);
    if (v && v !== value) onCommit(v);
  };
  return (
    <Input
      type="text"
      autoComplete="off"
      spellCheck={false}
      maxLength={NAME_MAX}
      {...props}
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
          e.currentTarget.blur();
        } else if (e.key === "Escape" && draft !== null) {
          e.preventDefault();
          e.stopPropagation();
          setDraft(null);
        }
      }}
      className={cn(
        inputFieldClass,
        inline && "h-7 border-transparent bg-transparent px-1.5 font-medium hover:border-control-border focus-visible:bg-field dark:bg-transparent dark:focus-visible:bg-field",
        className,
      )}
    />
  );
}

/**
 * The Only people switch of a state or a label (ADR 0037): on, agents leave it to people. Only a signed-in admin flips it
 * (`editable`); the others see the lock while it is on. Off, it shows on the row's hover, as Make default does.
 */
export function OnlyPeopleButton({ name, on, editable, hint, onChange }: { name: string; on: boolean; editable: boolean; hint: string; onChange: (on: boolean) => void }) {
  if (!editable)
    return on ? (
      <Hint label={hint}>
        <span role="img" aria-label={`${name}: ${hint}`} className="grid size-7 place-items-center text-ink-2 [&>svg]:size-3.5">
          <LockSimpleIcon weight="bold" />
        </span>
      </Hint>
    ) : (
      <span aria-hidden className="size-7" />
    );
  return (
    <Hint label={on ? hint : `Off: agents may change it too. Turn on: ${hint.toLowerCase()}`}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Only people: ${name}`}
        aria-pressed={on}
        className={cn(on ? "text-ink" : "text-ink-3 opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 pointer-coarse:opacity-100")}
        onClick={() => onChange(!on)}
      >
        <LockSimpleIcon weight={on ? "bold" : "regular"} />
      </Button>
    </Hint>
  );
}

/** A row's trash button: opens the ConfirmBar under the row. */
export function DeleteButton({ name, open, onToggle, hint = "Delete", disabled = false }: { name: string; open: boolean; onToggle: () => void; hint?: string; disabled?: boolean }) {
  return (
    <Hint label={hint}>
      <Button variant="ghost" size="icon-sm" className="text-ink-3 hover:text-signal-text" aria-label={`Delete ${name}`} disabled={disabled} aria-expanded={open} onClick={onToggle}>
        <TrashIcon />
      </Button>
    </Hint>
  );
}

/**
 * A destructive step confirmed in place, under the row it belongs to: what will happen, the controls it needs, the
 * button. Esc or Cancel closes it; it takes focus so the keyboard lands on it.
 */
export function ConfirmBar({ children, action, onConfirm, onCancel }: { children: ReactNode; action: string; onConfirm: () => void; onCancel: () => void }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => el?.querySelector<HTMLElement>("select, button")?.focus(), [el]);
  return (
    <div
      ref={setEl}
      role="group"
      aria-label={action}
      data-no-drag
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
      className="flex animate-in flex-wrap items-center gap-2 border-t border-dashed border-control-border pt-2.5 text-label text-ink-2 fade-in-0 slide-in-from-top-1"
    >
      <span className="min-w-0 flex-[1_1_240px]">{children}</span>
      <Button variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
      <Button className="bg-danger text-white hover:bg-danger/90" onClick={onConfirm}>
        {action}
      </Button>
    </div>
  );
}

/**
 * A token, passkey or session in a list: what it is, a line of facts, and the step that ends it, confirmed in place.
 * Long facts wrap on a phone rather than hide the date someone came to read.
 */
export function CredentialRow({
  icon,
  title,
  tag,
  facts,
  extra,
  action,
  question,
  onConfirm,
}: {
  icon: ReactNode;
  title: string;
  tag?: ReactNode;
  facts: ReactNode;
  /** Another action of the row, before the confirmed one. */
  extra?: ReactNode;
  action: string;
  question: ReactNode;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col border-b transition-colors duration-200 last:border-b-0 hover:bg-row-hover">
      <div className="flex min-h-12 items-center gap-2.5 px-3 py-1.5">
        <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full border border-control-border text-ink-2 [&>svg]:size-3.5">
          {icon}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5 font-medium">
            <span className="truncate">{title}</span>
            {tag}
          </span>
          <span className="text-xs text-ink-3 md:truncate">{facts}</span>
        </span>
        {extra}
        <Button variant="ghost" size="sm" className="shrink-0 text-signal-text" aria-label={`${action}: ${title}`} aria-expanded={open} onClick={() => setOpen(!open)}>
          {action}
        </Button>
      </div>
      {open && (
        <div className="px-3 pb-2.5 pl-[50px] max-md:pl-3">
          <ConfirmBar
            action={action}
            onCancel={() => setOpen(false)}
            onConfirm={() => {
              setOpen(false);
              onConfirm();
            }}
          >
            {question}
          </ConfirmBar>
        </div>
      )}
    </div>
  );
}

/** A row of a box of choices: what leads it, a name with its hint, then the control (a quiet Segmented): token access, member rights, notifications per workspace. */
export function ChoiceRow({ name, hint, lead, hintClass, children }: { name: string; hint?: string | undefined; lead?: ReactNode; hintClass?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-10 items-center gap-2.5 border-t border-rule-soft py-1.5 first:border-t-0 max-md:flex-wrap">
      {lead}
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
        {name}
        {hint && <span className={cn("ml-2 text-[12px] font-normal text-ink-3", hintClass)}>{hint}</span>}
      </span>
      {children}
    </div>
  );
}

/** A list's size beside its title. */
export const Count = ({ n }: { n: number }) => <span className="font-mono text-[11px] text-ink-3">{n}</span>;

/** A list's empty state or a load that failed. */
export const ListNote = ({ children }: { children: ReactNode }) => <p className="m-0 rounded-(--float-radius) border border-dashed p-4 text-label text-ink-3">{children}</p>;

/**
 * The end of a dialog's form: its error, if any, then Cancel and the submit button. With `busy` both are off and the
 * button spins while it runs; with `onSubmit` the button runs it instead of submitting a form.
 */
export function FormEnd({
  error,
  onCancel,
  disabled,
  busy,
  onSubmit,
  children,
}: {
  error: string | null;
  onCancel: () => void;
  disabled: boolean;
  busy?: boolean;
  onSubmit?: () => Promise<void>;
  children: ReactNode;
}) {
  return (
    <>
      <ErrorLine error={error} />
      <DialogFooter>
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button type={onSubmit ? "button" : "submit"} disabled={disabled} {...(onSubmit ? { onClick: () => void onSubmit() } : {})}>
          {busy && <Spinner className="size-3.5" />}
          {children}
        </Button>
      </DialogFooter>
    </>
  );
}

/** A picture dialog's end: Cancel and Save, both off while it saves. */
export const SaveFooter = ({ busy, error, onCancel, onSave }: { busy: boolean; error: string | null; onCancel: () => void; onSave: () => Promise<void> }) => (
  <FormEnd error={error} busy={busy} disabled={busy} onCancel={onCancel} onSubmit={onSave}>
    Save
  </FormEnd>
);

/** A labelled field of a dialog's form: the label above, then the control and whatever goes under it. */
export function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      {htmlFor ? (
        <Label htmlFor={htmlFor} className="text-[length:inherit] leading-[inherit]">
          {label}
        </Label>
      ) : (
        <span className="font-medium">{label}</span>
      )}
      {children}
    </div>
  );
}

/** A secret in a dialog, shown this once (a new token, a terminal's sign-in code), with Copy and Done. */
export function SecretOnce({ title, description, what, secret, onDone }: { title: string; description: ReactNode; what: string; secret: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <code aria-label={`The ${what}`} className="block rounded-md border border-control-border bg-field p-2.5 font-mono text-[12.5px] break-all select-all">
        {secret}
      </code>
      <DialogFooter>
        <Button
          variant="outline"
          onClick={() =>
            void toClipboard(
              secret,
              () => setCopied(true),
              () => notice.show(`Couldn’t copy: select the ${what} and copy it by hand`),
            )
          }
        >
          <CopyIcon />
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button onClick={onDone}>Done</Button>
      </DialogFooter>
    </>
  );
}
