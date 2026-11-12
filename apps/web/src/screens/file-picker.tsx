// The system's file dialog behind a button of our own (RSVA-426): a hidden input, emptied after each pick so the same file
// can be picked again.
import { useRef } from "react";

/** `field` goes anywhere in the tree; `pick` opens the dialog. */
export function useFilePicker(onFiles: (files: File[]) => void, { multiple = true, accept }: { multiple?: boolean; accept?: string } = {}) {
  const input = useRef<HTMLInputElement>(null);
  return {
    pick: () => input.current?.click(),
    field: (
      <input
        ref={input}
        type="file"
        multiple={multiple}
        hidden
        {...(accept ? { accept } : {})}
        onChange={(e) => {
          onFiles([...(e.currentTarget.files ?? [])]);
          e.currentTarget.value = "";
        }}
      />
    ),
  };
}
