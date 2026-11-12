/** The recursiva mark: one Hilbert path ending in a signal-coloured square. The favicon in index.html draws the same. */
export function Mark({ size = 19 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 96 96" aria-hidden>
      <path d="M15 15h22v22H15v44h22V59h22v22h22V37H59V15h11" fill="none" stroke="var(--color-ink)" strokeWidth="10" />
      <rect x="74" y="8" width="14" height="14" fill="var(--color-signal)" />
    </svg>
  );
}
