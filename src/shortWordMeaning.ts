// Old cached definitions may still contain paragraphs. Keep the reading UI brief;
// the original definition remains intact in the saved vocabulary data.
export function shortWordMeaning(value: string) {
  const first = value.trim().split(/\n|[.!?。](?:\s|$)/)[0].replace(/\s+/g, ' ').trim()
  return first.length > 40 ? `${first.slice(0, 39).trimEnd()}…` : first
}
