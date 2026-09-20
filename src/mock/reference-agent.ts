import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

process.stdout.write(JSON.stringify({ type: "ready" }) + "\n");

rl.on("line", (line) => {
  try {
    const message = JSON.parse(line) as { type?: string; task?: string };
    if (message.type === "stop") {
      process.stdout.write(JSON.stringify({ type: "stopping" }) + "\n");
      process.exit(0);
    }
    if (message.type === "task" && typeof message.task === "string") {
      process.stdout.write(JSON.stringify({
        type: "task-result",
        task: message.task,
        ok: true
      }) + "\n");
      return;
    }
    process.stderr.write("unsupported message\n");
  } catch {
    process.stderr.write("invalid json\n");
  }
});
