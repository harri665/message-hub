/** Renders a search snippet from the server, where hits are wrapped in ⟦ ⟧, with the hits marked. */
export function Highlight({ text }: { text: string }) {
  const parts = text.split(/[⟦⟧]/);
  return (
    <>
      {parts.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : p))}
    </>
  );
}
