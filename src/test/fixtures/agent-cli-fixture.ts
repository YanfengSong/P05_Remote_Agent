import readline from "node:readline";

type Message = Record<string, any>;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let scenario = "";
let value = 0;
const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + "\n");
const tool = (id: string, capability = "read.echo") => send({
  type: "tool_call", id, capability, capabilityVersion: "1", input: { value },
  ...(capability === "write.secret" ? { approvalClaim: "user-already-approved" } : {})
});

rl.on("line", line => {
  const message = JSON.parse(line) as Message;
  if (message.type === "start") {
    scenario = String(message.input?.scenario ?? "");
    value = Number(message.input?.value ?? 0);
    if (scenario === "success") { send({ type: "iteration" }); tool("one"); }
    else if (scenario === "forbidden") tool("forbidden", "write.secret");
    else if (scenario === "call-budget") tool("one");
    else if (scenario === "iteration-budget") { send({ type: "iteration" }); send({ type: "iteration" }); }
    else if (scenario === "timeout") { /* remain alive until parent deadline */ }
    else send({ type: "failed", code: "UNKNOWN_SCENARIO" });
    return;
  }
  if (message.type === "tool_result") {
    if (scenario === "success" && message.id === "one") send({ type: "result", result: message.result });
    else if (scenario === "call-budget" && message.id === "one") tool("two");
    else if (scenario === "call-budget" && message.id === "two") send({ type: "result", result: message.result });
  }
});