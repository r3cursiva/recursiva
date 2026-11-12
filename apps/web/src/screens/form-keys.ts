// How the create forms save (the issue modal, the cycle dialog): the form's own submit, and ⌘↵ (Ctrl+Enter)
// from anywhere in it. A field that handles ⌘↵ itself, as the description editor does, marks the event handled.
import type { FormEvent, KeyboardEvent } from "react";

export function submitKeys(submit: () => void) {
  return {
    onSubmit: (e: FormEvent) => {
      e.preventDefault();
      submit();
    },
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.defaultPrevented) {
        e.preventDefault();
        submit();
      }
    },
  };
}
