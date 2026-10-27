import {
  PATCH_LIMITS,
  type PatchDiffSummary,
  type TextEdit
} from "./file-contracts.js";

export type PatchEditErrorCode =
  | "INVALID_EDIT"
  | "EMPTY_OLD_TEXT"
  | "MISSING_EDIT"
  | "AMBIGUOUS_EDIT"
  | "OVERLAPPING_EDITS";

export class PatchEditError extends Error {
  readonly code: PatchEditErrorCode;

  constructor(code: PatchEditErrorCode, message: string) {
    super(message);
    this.name = "PatchEditError";
    this.code = code;
  }
}

type EditSpan = {
  start: number;
  end: number;
  text: string;
};

/**
 * Locate every edit in the same original string, reject ambiguous or overlapping
 * occurrences, then apply from the end so earlier offsets stay valid.
 *
 * Matching is deliberately literal: there is no fuzzy matching, line-ending
 * normalization or automatic whitespace handling.
 */
export function applyEditsToText(original: string, edits: readonly TextEdit[]): string {
  if (edits.length < 1 || edits.length > PATCH_LIMITS.maxEditsPerFile) {
    throw new PatchEditError(
      "INVALID_EDIT",
      "A file patch requires 1 to " + PATCH_LIMITS.maxEditsPerFile + " edits."
    );
  }

  const spans: EditSpan[] = edits.map((edit) => {
    if (edit.old_text.length === 0) {
      throw new PatchEditError("EMPTY_OLD_TEXT", "old_text must not be empty.");
    }

    const start = original.indexOf(edit.old_text);
    if (start < 0) {
      throw new PatchEditError("MISSING_EDIT", "old_text was not found.");
    }
    // Starting at start + 1 also catches overlapping occurrences such as "aa"
    // inside "aaa"; both are ambiguous and must not be guessed.
    if (original.indexOf(edit.old_text, start + 1) >= 0) {
      throw new PatchEditError(
        "AMBIGUOUS_EDIT",
        "old_text is ambiguous because it occurs more than once."
      );
    }

    return {
      start,
      end: start + edit.old_text.length,
      text: edit.new_text
    };
  }).sort((left, right) => left.start - right.start);

  for (let index = 1; index < spans.length; index += 1) {
    if (spans[index - 1]!.end > spans[index]!.start) {
      throw new PatchEditError(
        "OVERLAPPING_EDITS",
        "Edits overlap in the original text."
      );
    }
  }

  let result = original;
  for (const span of [...spans].reverse()) {
    result = result.slice(0, span.start) + span.text + result.slice(span.end);
  }
  return result;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let newlines = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 0x0a) newlines += 1;
  }
  return text.endsWith("\n") ? newlines : newlines + 1;
}

const MAX_PREVIEW_CHARS = 1024;
const MAX_PREVIEW_SIDE_CHARS = 180;

function clipPreview(value: string): string {
  return value.length <= MAX_PREVIEW_SIDE_CHARS
    ? value
    : value.slice(0, MAX_PREVIEW_SIDE_CHARS) + "…";
}

/**
 * Build a small, bounded description of the requested edits for dry runs. The
 * preview is intentionally not a full unified diff: the authoritative result is
 * the expected new SHA-256.
 */
export function summarizeEdits(
  original: string,
  updated: string,
  edits: readonly TextEdit[]
): PatchDiffSummary {
  const parts: string[] = [];
  let used = 0;
  for (const edit of edits) {
    const part = "- " + clipPreview(edit.old_text) + "\n+ " + clipPreview(edit.new_text);
    if (parts.length > 0 && used + part.length + 1 > MAX_PREVIEW_CHARS) {
      parts.push("…");
      break;
    }
    parts.push(part);
    used += part.length + 1;
  }

  return {
    edits: edits.length,
    bytesBefore: Buffer.byteLength(original, "utf8"),
    bytesAfter: Buffer.byteLength(updated, "utf8"),
    linesBefore: countLines(original),
    linesAfter: countLines(updated),
    preview: parts.join("\n").slice(0, MAX_PREVIEW_CHARS),
    previewTruncated: false
  };
}
