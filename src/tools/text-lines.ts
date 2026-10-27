/**
 * Line-oriented helpers that do not materialize one string per line for the whole
 * file. Search still receives lines with their newline; readRange uses the single
 * scan window selected below.
 */
export type LineWindow = {
  totalLines: number;
  text: string;
  returnedLines: number;
};

/**
 * Scan the text once, count lines, and slice only the requested line window.
 *
 * Lines retain their newline character (including CRLF). An empty file has zero
 * lines; a trailing newline terminates the last line and does not create an extra
 * empty line.
 */
export function selectLineWindow(
  text: string,
  offset: number,
  limit: number
): LineWindow {
  const safeOffset = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : 0;

  let totalLines = 0;
  let lineStart = 0;
  let windowStart = -1;
  let windowEnd = -1;

  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 0x0a) continue;

    if (safeLimit > 0 && totalLines === safeOffset) {
      windowStart = lineStart;
    }
    totalLines += 1;
    if (
      safeLimit > 0 &&
      windowStart >= 0 &&
      totalLines === safeOffset + safeLimit
    ) {
      windowEnd = index + 1;
    }
    lineStart = index + 1;
  }

  // A final line without a trailing newline still counts and may be selected.
  if (lineStart < text.length) {
    if (safeLimit > 0 && totalLines === safeOffset) {
      windowStart = lineStart;
    }
    totalLines += 1;
    if (
      safeLimit > 0 &&
      windowStart >= 0 &&
      totalLines === safeOffset + safeLimit
    ) {
      windowEnd = text.length;
    }
  }

  const returnedLines = safeLimit > 0 && windowStart >= 0
    ? Math.min(safeLimit, totalLines - safeOffset)
    : 0;
  if (returnedLines > 0 && windowEnd < 0) {
    windowEnd = text.length;
  }

  return {
    totalLines,
    text: returnedLines > 0 && windowStart >= 0 && windowEnd >= windowStart
      ? text.slice(windowStart, windowEnd)
      : "",
    returnedLines
  };
}

/** Yield lines including their trailing newline; no extra line after a final LF. */
export function* iterateLines(text: string): Generator<string> {
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 0x0a) continue;
    yield text.slice(start, index + 1);
    start = index + 1;
  }
  if (start < text.length) yield text.slice(start);
}
