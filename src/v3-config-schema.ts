import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod/v4";
import { V3_CONFIG_SCHEMA } from "./v3/config.js";

const document = JSON.stringify({ ...z.toJSONSchema(V3_CONFIG_SCHEMA, { io: "input" }), title: "P05 V3 local Core configuration",
  description: "Local operator-controlled configuration. Runtime also verifies absolute paths, real workspace boundaries and OS permissions." }, null, 2) + "\n";
if (process.argv[2] === "--write-docs") {
  const target = fileURLToPath(new URL("../docs/schemas/v3-config.schema.json", import.meta.url));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, document, "utf8");
  process.stdout.write("V3_CONFIG_SCHEMA_WRITTEN\n");
} else process.stdout.write(document);
