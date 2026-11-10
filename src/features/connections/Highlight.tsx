import styles from './Highlight.module.css';

/** Renders `text` with the fuzzy-matched characters emphasized. */
export function Highlight({ text, indices }: { text: string; indices: readonly number[] }) {
  if (indices.length === 0) return <>{text}</>;
  const marked = new Set(indices);
  const parts: { text: string; match: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const match = marked.has(i);
    const last = parts.at(-1);
    if (last?.match === match) last.text += text.charAt(i);
    else parts.push({ text: text.charAt(i), match });
  }
  return (
    <>
      {parts.map((part, index) =>
        part.match ? (
          <mark key={index} className={styles.mark}>
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}
