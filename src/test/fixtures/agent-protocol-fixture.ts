type Message = Record<string, any>;
let value = 0;
const send = (message: unknown) => process.send?.(message as never);
process.on("message", raw => {
  const message = raw as Message;
  if (message.type === "start") {
    const scenario = String(message.input?.scenario ?? "");
    value = Number(message.input?.value ?? 0);
    if (scenario !== "success") { send({ type: "failed", code: "UNKNOWN_SCENARIO" }); return; }
    send({ type: "iteration" });
    send({ type: "tool_call", id: "ipc-one", capability: "read.echo", capabilityVersion: "1", input: { value } });
    return;
  }
  if (message.type === "tool_result" && message.id === "ipc-one") send({ type: "result", result: message.result });
});