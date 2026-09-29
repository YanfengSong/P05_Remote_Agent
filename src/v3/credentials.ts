import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** State root must already have passed the Core path/protection checks. */
export function loadOrCreateToken(stateDir: string, role: "client" | "operator"): { file: string; token: string } {
  const file = path.join(stateDir, `${role}.token`);
  const candidate = randomBytes(32).toString("hex");
  try {
    fs.writeFileSync(file, candidate + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256) throw new Error("Invalid credential file");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("Credential file must be private");
  const token = fs.readFileSync(file, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid credential format");
  return { file, token };
}
