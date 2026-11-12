// The issue panel's links, as in Plane: "+" opens a form (paste the address, a title if wanted), each card opens its link
// in a new tab and can be edited or removed. A GitHub pull request or commit reads as "owner/repo#12" or "owner/repo@abc1234"
// when it has no title (readLink in packages/schema). Cards as the IssuePage artboard's `.card`; a pull request's state and
// checks stay in the Pull requests block (github-panel.tsx), not here.
import { GitCommitIcon, GitPullRequestIcon, LinkSimpleIcon, PencilSimpleIcon } from "@phosphor-icons/react";
import { cleanUrl, readLink, type Attachment, type Issue } from "@rsva/schema/models";
import { Button } from "@rsva/ui/components/button";
import { Input } from "@rsva/ui/components/input";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { useState, type FormEvent } from "react";
import { exactTime, shortTime, useNow } from "../lib/time.ts";
import { store } from "../store.ts";
import { notice } from "./notice.ts";
import { PanelList, PanelPlus, PanelSection, RemoveButton, RowButton } from "./panel-section.tsx";
import { plural } from "@rsva/schema/util";

const KIND_ICON = { link: LinkSimpleIcon, github_pr: GitPullRequestIcon, github_commit: GitCommitIcon } as const;

/** What a link row says: its title, else the GitHub reference, else the address without its scheme. */
function linkText(a: Pick<Attachment, "url" | "title">): string {
  return a.title || readLink(a.url).ref || a.url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/** `adding` is held by the block around it: the row under the description and a phone's Add start a link too (issue-blocks.tsx). */
export const Links = observer(function Links({ issue, adding, setAdding }: { issue: Issue; adding: boolean; setAdding: (adding: boolean) => void }) {
  const links = store.attachmentsOf(issue.id).filter((a) => a.kind !== "file");
  return (
    <PanelSection
      label="Links"
      noPhoneHeader
      className="md:gap-1.5"
      empty={links.length === 0 && !adding}
      count={links.length > 0 ? { text: String(links.length), title: plural(links.length, "link") } : null}
      action={<PanelPlus label="Add link" onClick={() => setAdding(true)} />}
    >
      {adding && (
        <LinkForm
          onSave={(url, title) => {
            store.addLink(issue.id, url, title);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      )}
      {links.length > 0 && (
        <PanelList className="md:gap-1.5">
          {links.map((a) => (
            <LinkRow key={a.id} link={a} />
          ))}
        </PanelList>
      )}
    </PanelSection>
  );
});

/** Off the issue, with Undo: the same address and title come back. */
function removeLink(link: Attachment): void {
  const { issueId, url, title } = link;
  store.removeLink(link.id);
  notice.show(`${linkText(link)} removed`, () => store.addLink(issueId, url, title));
}

const LinkRow = observer(function LinkRow({ link }: { link: Attachment }) {
  const [editing, setEditing] = useState(false);
  const now = useNow();
  if (editing) {
    return (
      <li>
        <LinkForm
          initial={link}
          onSave={(url, title) => {
            store.updateLink(link.id, { url, title });
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      </li>
    );
  }
  const Icon = KIND_ICON[link.kind as keyof typeof KIND_ICON] ?? LinkSimpleIcon;
  const host = URL.canParse(link.url) ? new URL(link.url).host : "";
  const author = link.createdById ? store.users.get(link.createdById)?.name : undefined;
  const pr = link.kind === "github_pr";
  const ref = readLink(link.url).ref;
  return (
    <li className="max-md:mt-2">
      <div className="group/sub flex items-center gap-3 rounded-lg border border-rule bg-panel px-3 py-2.5 transition-colors duration-120 hover:border-rule-strong has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-ring">
      <Icon className={cn("size-4 shrink-0 text-ink-3 max-md:size-[18px]", pr && "max-md:text-status-done")} />
      <a href={link.url} target="_blank" rel="noopener noreferrer" title={link.url} className="flex min-w-0 flex-1 flex-col gap-[3px] outline-none">
        <span className="truncate text-[13px] font-medium max-md:text-[13.5px]">{linkText(link)}</span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-3">
          {link.title && (ref ?? host) && <span className="min-w-0 truncate font-mono text-[11px]">{ref ?? host}</span>}
          <span title={exactTime(link.createdAt)}>
            {author ? `added by ${author} · ` : ""}
            {shortTime(link.createdAt, now)}
          </span>
        </span>
      </a>
      <RowButton label="Edit link" onClick={() => setEditing(true)}>
        <PencilSimpleIcon />
      </RowButton>
      <RemoveButton label="Remove link" onClick={() => removeLink(link)} />
      </div>
    </li>
  );
});

/** Address and title; Enter saves, Esc cancels. An address that is not http or https says so instead of saving. */
function LinkForm({ initial, onSave, onCancel }: { initial?: Pick<Attachment, "url" | "title">; onSave: (url: string, title: string) => void; onCancel: () => void }) {
  const [url, setUrl] = useState(initial?.url ?? "");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [bad, setBad] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!cleanUrl(url)) return setBad(true);
    onSave(url, title);
  };
  return (
    <form onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onCancel())} className="flex flex-col gap-1.5 py-2">
      <Input
        autoFocus
        aria-label="Link address"
        aria-invalid={bad || undefined}
        placeholder="https://…"
        value={url}
        onChange={(e) => (setUrl(e.target.value), setBad(false))}
        className="h-7 text-[13px] max-md:h-11 max-md:text-base"
      />
      <Input aria-label="Link title" placeholder="Title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} className="h-7 text-[13px] max-md:h-11 max-md:text-base" />
      {bad && <p className="m-0 text-caption text-signal-text">Not an http or https address</p>}
      <span className="flex justify-end gap-1.5">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm">
          {initial ? "Save" : "Add link"}
        </Button>
      </span>
    </form>
  );
}
