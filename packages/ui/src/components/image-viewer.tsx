// An image at the size of the window, over the page: Esc or a click beside it closes, the arrows step through the
// images it was opened among, a click on a picture larger than the window shows it at its own size, scrolled.
//
// Considered: a card of the file with a download link in place of the picture (a screenshot is in a comment to be seen,
// not to be opened), and resizing the picture in the text by its corner (the size would have to live in the Markdown,
// which people and agents write by hand). A preview of limited height in the text (content.css) and this viewer keep
// the text as it is.
import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { ArrowSquareOutIcon, CaretLeftIcon, CaretRightIcon, XIcon } from "@phosphor-icons/react"
import { Button } from "@rsva/ui/components/button"
import { cn } from "../lib/utils.ts"

export interface ViewedImage {
  src: string
  alt: string
}

const BAR_BUTTON = "text-white/80 hover:bg-white/10 hover:text-white max-md:size-11"
const STEP_BUTTON = cn(BAR_BUTTON, "absolute top-1/2 z-10 size-10 -translate-y-1/2 rounded-full bg-black/40 max-md:size-11")

function ImageViewer({
  images,
  index,
  onIndexChange,
  onClose,
}: {
  images: readonly ViewedImage[]
  index: number
  onIndexChange: (index: number) => void
  onClose: () => void
}) {
  const image = images[index]
  // `full`: at its own size. `larger`: it has more pixels than the window shows, so a click has something to show.
  const [full, setFull] = React.useState(false)
  const [larger, setLarger] = React.useState(false)
  React.useEffect(() => {
    setFull(false)
    setLarger(false)
  }, [image?.src])
  // Focus starts on the viewer itself: the arrows work at once and no button wears a ring over the picture.
  const popup = React.useRef<HTMLDivElement>(null)
  if (!image) return null
  const many = images.length > 1
  const step = (by: number) => onIndexChange((index + by + images.length) % images.length)
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 isolate z-50 bg-black/85 duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup
          data-slot="image-viewer"
          ref={popup}
          initialFocus={popup}
          tabIndex={-1}
          className="fixed inset-0 z-50 flex flex-col text-white outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
          onKeyDown={(e) => {
            if (!many || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return
            e.preventDefault()
            step(e.key === "ArrowRight" ? 1 : -1)
          }}
        >
          <div className="flex h-12 shrink-0 items-center gap-1 px-3 max-md:h-14 max-md:px-1.5">
            <DialogPrimitive.Title className="min-w-0 flex-1 truncate text-label font-medium max-md:pl-2">{image.alt || "Image"}</DialogPrimitive.Title>
            {many && (
              <span className="px-2 font-mono text-meta text-white/60">
                {index + 1} / {images.length}
              </span>
            )}
            <Button variant="ghost" size="icon" aria-label="Open original" className={BAR_BUTTON} render={<a href={image.src} target="_blank" rel="noopener noreferrer" />}>
              <ArrowSquareOutIcon />
            </Button>
            <DialogPrimitive.Close render={<Button variant="ghost" size="icon" aria-label="Close" className={BAR_BUTTON} />}>
              <XIcon />
            </DialogPrimitive.Close>
          </div>
          {/* A click on the ground around the picture closes; the picture is centred by its margins, so one larger than
              the window scrolls from its corner rather than being cut. */}
          <div className="relative flex min-h-0 flex-1">
            <div className="flex min-h-0 flex-1 overflow-auto p-4 max-md:p-0" onClick={(e) => e.target === e.currentTarget && onClose()}>
              <img
                key={image.src}
                src={image.src}
                alt={image.alt}
                className={cn("m-auto rounded-sm", full ? "max-w-none" : "max-h-full max-w-full object-contain", larger && (full ? "cursor-zoom-out" : "cursor-zoom-in"))}
                onLoad={(e) => setLarger(e.currentTarget.naturalWidth > e.currentTarget.clientWidth + 1)}
                onClick={() => larger && setFull(!full)}
              />
            </div>
            {many && (
              <>
                <Button variant="ghost" size="icon" aria-label="Previous image" className={cn(STEP_BUTTON, "left-3 max-md:left-1.5")} onClick={() => step(-1)}>
                  <CaretLeftIcon />
                </Button>
                <Button variant="ghost" size="icon" aria-label="Next image" className={cn(STEP_BUTTON, "right-3 max-md:right-1.5")} onClick={() => step(1)}>
                  <CaretRightIcon />
                </Button>
              </>
            )}
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export { ImageViewer }
