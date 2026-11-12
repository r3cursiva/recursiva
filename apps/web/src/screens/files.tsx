// The issue panel's files (PLNR-50): Attach picks files, dropping them on the blocks attaches them, each row opens or
// downloads its file and can be removed. Images in a description or a comment go through the editor (filesFor below):
// an image is put in the text, any other file lands here, on the issue.
import { FileIcon, ImageIcon } from "@phosphor-icons/react";
import { fileLink } from "@rsva/editor/doc";
import type { FileHandler } from "@rsva/editor/editor";
import type { Attachment, Issue } from "@rsva/schema/models";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { useState } from "react";
import { altHeld, formatSize, isImage, uploadFile, type Uploaded } from "../lib/upload.ts";
import { store } from "../store.ts";
import { useFileDrop } from "./file-drop.ts";
import { notice } from "./notice.ts";
import { PanelList, PanelSection, RemoveButton } from "./panel-section.tsx";
import { plural } from "@rsva/schema/util";
import { useFilePicker } from "./file-picker.tsx";

/** A file's address with its name, for the download's file name (Content-Disposition). */
const fileHref = (a: Pick<Attachment, "url" | "title">): string => `${a.url}?name=${encodeURIComponent(a.title)}`;

/** Uploads files and attaches them to the issue; failures say so in a toast. */
async function attach(issueId: string, files: File[], original: boolean): Promise<void> {
  const slug = store.workspace?.slug;
  if (!slug) return;
  await Promise.all(
    files.map(async (f) => {
      try {
        const up = await uploadFile(slug, f, { original });
        store.addFile(issueId, up, up.name);
      } catch (e) {
        notice.show(e instanceof Error ? e.message : `${f.name} did not upload`);
      }
    }),
  );
}

/**
 * The editor's file handler for an issue's text: images upload and go into the text; any other file is attached to the
 * issue, or, in the create modal, where there is no issue yet, handed to `target` to attach once there is one. `linked`
 * (a comment): the file also stands in the text, as a card.
 */
export function filesFor(target: string | ((up: Uploaded) => void), linked = false): FileHandler {
  return (files) => {
    const slug = store.workspace?.slug;
    const original = altHeld();
    return files.map(async (f) => {
      if (!slug) return null;
      let up: Uploaded;
      try {
        up = await uploadFile(slug, f, { original });
      } catch (e) {
        notice.show(e instanceof Error ? e.message : `${f.name} did not upload`);
        return null;
      }
      if (isImage(up.mime)) return { src: up.src, alt: up.name.replace(/\.[^.]*$/, "") };
      if (typeof target === "string") {
        store.addFile(target, up, up.name);
        if (linked) return { href: fileLink(up.src, up.name, up.size), name: up.name };
        notice.show(`${up.name} attached`);
      } else {
        target(up);
      }
      return null;
    });
  };
}

/** Attaching files to an issue: the hidden field to render, the way to open it, and what makes an element a drop target. */
export function useAttach(issueId: string) {
  const [busy, setBusy] = useState(0);
  const add = (list: File[], original: boolean) => {
    if (!list.length) return;
    setBusy((n) => n + list.length);
    void attach(issueId, list, original).finally(() => setBusy((n) => n - list.length));
  };
  const { over, drop } = useFileDrop(add);
  const { pick, field } = useFilePicker((files) => add(files, altHeld()));
  return { busy, over, pick, field, drop };
}

/** `busy` counts files on their way. */
export const Files = observer(function Files({ issue, busy }: { issue: Issue; busy: number }) {
  const files = store.attachmentsOf(issue.id).filter((a) => a.kind === "file");
  return (
    <PanelSection
      label="Attachments"
      noPhoneHeader
      empty={files.length === 0 && busy === 0}
      count={files.length > 0 || busy > 0 ? { text: busy ? `${files.length} +${busy}` : String(files.length), title: busy ? `${busy} uploading` : plural(files.length, "file") } : null}
    >
      {files.length > 0 && (
        <PanelList className="border-t border-rule-soft max-md:mt-2 max-md:gap-1.5 max-md:border-t-0">
          {files.map((a) => (
            <FileRow key={a.id} file={a} />
          ))}
        </PanelList>
      )}
    </PanelSection>
  );
});

/** Off the issue, with Undo: the bytes stay in the workspace, so the same file comes back under its name. */
function removeFile(file: Attachment): void {
  const { issueId, sha256, size, mime, title } = file;
  store.removeLink(file.id);
  notice.show(`${title} removed`, sha256 ? () => store.addFile(issueId, { sha256, size: size ?? 0, mime: mime ?? "" }, title) : undefined);
}

const FileRow = observer(function FileRow({ file }: { file: Attachment }) {
  const image = isImage(file.mime);
  const author = file.createdById ? store.users.get(file.createdById)?.name : undefined;
  const Icon = image ? ImageIcon : FileIcon;
  // On a phone a card without a preview, as the artboard draws it.
  return (
    <li>
      <div className="group/sub relative flex h-8 items-center gap-2 border-b border-rule-soft md:row-plate max-md:h-11 max-md:rounded-md max-md:border max-md:border-rule max-md:bg-panel max-md:pr-2.5 max-md:pl-2 max-md:transition-colors max-md:hover:border-rule-strong max-md:hover:bg-row-hover">
      {image && <img src={file.url} alt="" loading="lazy" decoding="async" className="ml-1 size-5 shrink-0 rounded-xs object-cover max-md:hidden" />}
      <Icon weight="bold" className={cn("ml-1.5 size-4 shrink-0 text-ink-3 max-md:ml-0 max-md:size-[15px]", image && "md:hidden")} />
      <a
        href={fileHref(file)}
        {...(image ? { target: "_blank", rel: "noopener" } : { download: file.title })}
        title={[file.title, author && `Added by ${author}`].filter(Boolean).join("\n")}
        className="flex min-w-0 flex-1 items-baseline gap-2 outline-none max-md:after:absolute max-md:after:inset-0"
      >
        <span className="truncate text-[13px] max-md:text-[12.5px]">{file.title}</span>
        <span className="shrink-0 text-caption text-ink-3 max-md:font-mono max-md:text-[10.5px]">{formatSize(file.size)}</span>
      </a>
      <RemoveButton label="Remove file" onClick={() => removeFile(file)} className="relative z-1" />
      </div>
    </li>
  );
});
