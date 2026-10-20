type JsonRecord = Record<string, unknown>;
type PendingRequest = {
  id: string;
  tool: string;
  requestBytes: number;
  inputContentBytes?: number;
  startedAtNs: bigint;
};

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object"
    ? value as JsonRecord
    : undefined;
}

function toBuffer(chunk: string | Uint8Array, encoding: unknown): Buffer {
  if (typeof chunk === "string") {
    return Buffer.from(
      chunk,
      typeof encoding === "string" ? encoding as BufferEncoding : "utf8"
    );
  }
  return Buffer.from(chunk);
}

export function installStdioTrace(runtimeSlot: string | undefined): void {
  if (runtimeSlot !== "A" || process.env.P05_MCP_TRACE_STDIO !== "1") return;

  const configuredLimit = Number(process.env.P05_MCP_TRACE_STDIO_MAX ?? "8");
  const maxPairs = Number.isInteger(configuredLimit) && configuredLimit > 0
    ? Math.min(configuredLimit, 16)
    : 8;

  const pending = new Map<string, PendingRequest>();
  const stdout = process.stdout as unknown as {
    write: (chunk: string | Uint8Array, ...args: unknown[]) => boolean;
  };
  const originalWrite = stdout.write.bind(stdout);
  const writeStderr = process.stderr.write.bind(process.stderr);
  let inputBuffer = Buffer.alloc(0);
  let outputBuffer = Buffer.alloc(0);
  let active = true;
  let completedPairs = 0;

  const emit = (fields: JsonRecord): void => {
    try {
      writeStderr(JSON.stringify({
        event: "p05.stdio_trace",
        runtimeSlot: "A",
        ...fields
      }) + "\n");
    } catch {
      // Diagnostics must never affect the MCP protocol channel.
    }
  };

  const stop = (): void => {
    if (!active) return;
    active = false;
    process.stdin.off("data", onInput);
    stdout.write = originalWrite;
  };

  const onInputLine = (line: Buffer): void => {
    if (!active || line.length === 0) return;
    let message: JsonRecord;
    try {
      message = JSON.parse(line.toString("utf8")) as JsonRecord;
    } catch {
      return;
    }
    if (message.method !== "tools/call" || message.id === undefined || completedPairs >= maxPairs) return;

    const params = asRecord(message.params);
    const args = asRecord(params?.arguments);
    const tool = typeof params?.name === "string" ? params.name : "unknown";
    const id = String(message.id);
    const inputContentBytes = tool === "fs_write" && typeof args?.content === "string"
      ? Buffer.byteLength(args.content, "utf8")
      : undefined;
    pending.set(id, {
      id,
      tool,
      requestBytes: line.length + 1,
      ...(inputContentBytes === undefined ? {} : { inputContentBytes }),
      startedAtNs: process.hrtime.bigint()
    });
    emit({
      direction: "in",
      id,
      method: "tools/call",
      tool,
      requestLineBytes: line.length + 1,
      ...(inputContentBytes === undefined ? {} : { inputContentBytes }),
      at: new Date().toISOString()
    });
  };

  const onInput = (chunk: Buffer): void => {
    if (!active) return;
    inputBuffer = Buffer.concat([inputBuffer, chunk]);
    let newline = inputBuffer.indexOf(0x0a);
    while (newline >= 0) {
      onInputLine(inputBuffer.subarray(0, newline));
      inputBuffer = inputBuffer.subarray(newline + 1);
      newline = inputBuffer.indexOf(0x0a);
    }
  };

  const onOutputLine = (line: Buffer, writeAccepted: boolean, writeCallMs: number): void => {
    if (!active || line.length === 0) return;
    let message: JsonRecord;
    try {
      message = JSON.parse(line.toString("utf8")) as JsonRecord;
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const id = String(message.id);
    const request = pending.get(id);
    if (!request) return;

    const rawResult = asRecord(message.result);
    const nestedResult = asRecord(rawResult?.result);
    const result = nestedResult && ("content" in nestedResult || "structuredContent" in nestedResult)
      ? nestedResult
      : rawResult;
    const content = Array.isArray(result?.content) ? result.content : [];
    const contentTextBytes = content.reduce((total, item) => {
      const record = asRecord(item);
      return total + (typeof record?.text === "string" ? Buffer.byteLength(record.text, "utf8") : 0);
    }, 0);
    const structured = asRecord(result?.structuredContent);
    const structuredContentJsonBytes = result?.structuredContent === undefined
      ? 0
      : Buffer.byteLength(JSON.stringify(result.structuredContent), "utf8");
    const structuredTextBytes = typeof structured?.text === "string"
      ? Buffer.byteLength(structured.text, "utf8")
      : 0;
    const resultJsonBytes = result === undefined
      ? 0
      : Buffer.byteLength(JSON.stringify(result), "utf8");
    const elapsedMs = Number(process.hrtime.bigint() - request.startedAtNs) / 1e6;
    const responseLineBytes = line.length + 1;

    emit({
      direction: "out",
      id,
      tool: request.tool,
      requestLineBytes: request.requestBytes,
      ...(request.inputContentBytes === undefined ? {} : { inputContentBytes: request.inputContentBytes }),
      responseLineBytes,
      resultJsonBytes,
      contentTextBytes,
      structuredContentJsonBytes,
      structuredTextBytes,
      elapsedSinceInputMs: +elapsedMs.toFixed(3),
      stdoutWriteCallMs: +writeCallMs.toFixed(3),
      stdoutWriteAccepted: writeAccepted,
      isError: Boolean(message.error) || Boolean(asRecord(result)?.isError),
      at: new Date().toISOString()
    });

    pending.delete(id);
    completedPairs += 1;
    if (!writeAccepted) {
      const drainStartedNs = process.hrtime.bigint();
      process.stdout.once("drain", () => {
        emit({
          direction: "drain",
          id,
          tool: request.tool,
          drainWaitMs: +((Number(process.hrtime.bigint() - drainStartedNs)) / 1e6).toFixed(3),
          at: new Date().toISOString()
        });
      });
    }
    if (completedPairs >= maxPairs) stop();
  };

  const tracedWrite = (chunk: string | Uint8Array, ...args: unknown[]): boolean => {
    const bytes = toBuffer(chunk, args[0]);
    const startedNs = process.hrtime.bigint();
    const accepted = originalWrite(chunk, ...args);
    const writeCallMs = Number(process.hrtime.bigint() - startedNs) / 1e6;
    if (!active) return accepted;

    outputBuffer = Buffer.concat([outputBuffer, bytes]);
    let newline = outputBuffer.indexOf(0x0a);
    while (newline >= 0) {
      onOutputLine(outputBuffer.subarray(0, newline), accepted, writeCallMs);
      outputBuffer = outputBuffer.subarray(newline + 1);
      if (!active) break;
      newline = outputBuffer.indexOf(0x0a);
    }
    return accepted;
  };

  stdout.write = tracedWrite;
  process.stdin.on("data", onInput);
  emit({ direction: "enabled", maxPairs, note: "No request arguments or file contents are logged." });
}
