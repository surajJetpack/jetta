/**
 * A number in a table that opens the records behind it. Zero stays plain
 * text: there is nothing behind it to open.
 */
export function CellLink({ n, onClick, children }: { n: number; onClick: () => void; children: React.ReactNode }) {
  if (!n) return <>{children}</>;
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-sm tabular-nums underline decoration-dotted underline-offset-4 hover:decoration-solid outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      {children}
    </button>
  );
}
