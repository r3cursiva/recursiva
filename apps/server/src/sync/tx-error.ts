// What the write pipeline's op handlers share: the rejection error and the action before it gets its number.
import type { Action } from "@rsva/protocol";

export class TxError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** An action before it gets its number, with the before-values of a U (stored, not broadcast). */
export type Pending = Omit<Action, "id" | "by"> & { p?: Record<string, unknown> };
