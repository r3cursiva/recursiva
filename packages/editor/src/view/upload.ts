// Files dropped or pasted into the editor (PLNR-50). The editor does not upload: it hands the files to the app (onFiles),
// shows a placeholder where each will go, and puts an image there when the app's promise brings one. The placeholder is a
// decoration, not a node: it is not in the document, so an autosave while a file uploads stores no half-made image, and
// it moves with the text typed around it (ProseMirror maps decorations through every change).
//
// Considered: inserting the image at once with a temporary `blob:` source and swapping it when the upload ends. The
// document would hold an address the schema refuses (and CSP's img-src does not allow blob:) until then; one autosave in
// that window would be refused by the server.
import type { Node } from "prosemirror-model";
import { Plugin, PluginKey, type EditorState } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { imageAltOf } from "../doc.ts";
import { droppableFiles } from "../drag.ts";
import { schema } from "../schema.ts";

/** What the app makes of one file: an image to insert, a link to it, or null (it went elsewhere, or failed: the app says so). */
type FileResult = Promise<{ src: string; alt: string } | { href: string; name: string } | null>;
/** Takes files dropped or pasted into the editor; one promise per file, in the same order. */
export type FileHandler = (files: File[]) => FileResult[];

type Meta = { add: { id: object; pos: number; name: string } } | { remove: object };

const key = new PluginKey<DecorationSet>("upload");

function placeholder(name: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "upload-placeholder";
  el.contentEditable = "false";
  el.textContent = `Uploading ${name}…`;
  return el;
}

export function uploadPlugin(onFiles: FileHandler): Plugin {
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        let next = set.map(tr.mapping, tr.doc);
        const m = tr.getMeta(key) as Meta | undefined;
        if (m && "add" in m) next = next.add(tr.doc, [Decoration.widget(m.add.pos, () => placeholder(m.add.name), { id: m.add.id, side: -1 })]);
        if (m && "remove" in m) next = next.remove(next.find(undefined, undefined, (spec) => spec.id === m.remove));
        return next;
      },
    },
    props: {
      decorations: (state) => key.getState(state),
      handlePaste(view, e) {
        const files = [...(e.clipboardData?.files ?? [])];
        if (!files.length) return false;
        upload(view, files, view.state.selection.from, onFiles);
        return true;
      },
      // A drag the page started (an image from another editor, or copied within this one with Alt) is left to ProseMirror,
      // which inserts the dragged slice: the same `/files/…` address and alt text, nothing uploaded (PLNR-386).
      handleDrop(view, e, _slice, moved) {
        const dt = (e as DragEvent).dataTransfer;
        if (moved || !dt || !droppableFiles(dt.types)) return false;
        const files = [...dt.files];
        if (!files.length) return false;
        const at = view.posAtCoords({ left: (e as DragEvent).clientX, top: (e as DragEvent).clientY });
        upload(view, files, at?.pos ?? view.state.selection.from, onFiles);
        return true;
      },
    },
  });
}

/** Where a placeholder is now, or null when its text was deleted while the file uploaded. */
function placeholderAt(state: EditorState, id: object): number | null {
  return key.getState(state)?.find(undefined, undefined, (spec) => spec.id === id)[0]?.from ?? null;
}

/** An image, or a paragraph of one link: a file in a comment, which reads as a card (render.ts). */
function nodeOf(got: { src: string; alt: string } | { href: string; name: string }): Node {
  if ("src" in got) return schema.nodes.image!.create({ src: got.src, alt: imageAltOf(got.alt) });
  return schema.nodes.paragraph!.create(null, schema.text(got.name, [schema.marks.link!.create({ href: got.href })]));
}

/** Hands the files to the app and puts each image or file where its placeholder ended up. */
export function upload(view: EditorView, files: File[], pos: number, onFiles: FileHandler): void {
  const results = onFiles(files);
  files.forEach((file, i) => {
    const id = {};
    view.dispatch(view.state.tr.setMeta(key, { add: { id, pos, name: file.name || "image" } } satisfies Meta));
    void (results[i] ?? Promise.resolve(null))
      .catch(() => null)
      .then((got) => {
        if (view.isDestroyed) return;
        const at = placeholderAt(view.state, id);
        const tr = view.state.tr.setMeta(key, { remove: id } satisfies Meta);
        if (got && at !== null) tr.replaceRangeWith(at, at, nodeOf(got));
        view.dispatch(tr);
      });
  });
}
