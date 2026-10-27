export function structuredResult<T extends Record<string, unknown>>(
  structuredContent: T,
  text = JSON.stringify(structuredContent, null, 2),
  isError = false
) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent,
    ...(isError ? { isError: true as const } : {})
  };
}
