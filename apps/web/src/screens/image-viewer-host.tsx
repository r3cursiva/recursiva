// The picture opened from text (image-view.ts), in the viewer of packages/ui.
import { ImageViewer } from "@rsva/ui/components/image-viewer";
import { observer } from "mobx-react-lite";
import { imageView } from "./image-view.ts";

const step = (index: number) => imageView.step(index);
const close = () => imageView.close();

export const ImageViewerHost = observer(function ImageViewerHost() {
  const cur = imageView.current;
  return cur && <ImageViewer images={cur.images} index={cur.index} onIndexChange={step} onClose={close} />;
});
