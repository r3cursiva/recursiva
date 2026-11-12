// Which drags carry files to take: the app's drop targets (apps/web, file-drop.ts) and the editor's upload (view/upload.ts).
// Here, not in the app, so the editor can tell the page's own drags apart; a module of its own, so the app's startup
// bundle gets these lines and not the editor.

/**
 * The type every drag that starts in the page carries (guardFileDrops in apps/web). Chrome puts a dragged <img> in the
 * drag as a file, and clearData() cannot take it out (ProseMirror calls it), so an editor's image or a file's thumbnail
 * dropped on a drop target would come back as a new attachment (PLNR-352), and an image dragged from one editor into
 * another would upload again (PLNR-386). Measured in Chrome 156: the type set at dragstart is there at dragover and drop,
 * beside "Files". Chosen over a flag set at dragstart and cleared at dragend: no state, so nothing to stick when the
 * dragged element leaves the page before dragend reaches the window; and over marking the editor's drags only:
 * thumbnails and links are dragged too.
 */
export const PAGE_DRAG = "application/x-rsva-page-drag";

export const carriesFiles = (types: readonly string[]): boolean => types.includes("Files");

/** Whether a drag's files are to be taken: files from outside the page, not what the page itself is dragging. */
export const droppableFiles = (types: readonly string[]): boolean => carriesFiles(types) && !types.includes(PAGE_DRAG);
