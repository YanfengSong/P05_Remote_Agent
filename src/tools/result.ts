export function structuredResult<T extends Record<string, unknown>>(
  structuredContent: T,
  text = JSON.stringify(structuredContent, null, 2)
) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent
  };
}
