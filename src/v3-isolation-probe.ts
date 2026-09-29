import { createIsolationBackend } from "./v3/isolation/backend.js";

try { process.stdout.write(JSON.stringify(await createIsolationBackend().probe(), null, 2) + "\n"); }
catch { process.stderr.write("Isolation probe unavailable; no isolated backend was enabled.\n"); process.exitCode = 1; }
