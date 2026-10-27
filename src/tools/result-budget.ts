/**
 * Size accounting for the complete MCP tool result, not just the raw file text.
 *
 * `structuredResult` emits the body twice: once in `content[].text` for plain-text
 * clients and once in `structuredContent` for machine clients. Budgeting only one
 * copy would exceed the advertised limit.
 */
export function serializedBytes(value: unknown): number {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("Value is not JSON-serializable.");
  return Buffer.byteLength(json, "utf8");
}

/** Mirrors the object shape produced by `structuredResult` in result.ts. */
export function toolResultBytes(
  structuredContent: unknown,
  text: string,
  isError = false
): number {
  return serializedBytes({
    content: [{ type: "text", text }],
    structuredContent,
    ...(isError ? { isError: true } : {})
  });
}
