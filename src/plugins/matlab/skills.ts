import fs from "node:fs";
import path from "node:path";

export type MatlabSkillSource = "matlab" | "simulink";

export type MatlabSkillDescriptor = {
  id: string;
  source: MatlabSkillSource;
  group: string;
  description: string;
  version?: string;
};

type MatlabSkillRecord = MatlabSkillDescriptor & {
  filePath: string;
};

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function frontMatter(text: string): string {
  if (!text.startsWith("---")) return "";
  const firstBreak = text.indexOf("\n");
  if (firstBreak < 0) return "";
  const end = text.indexOf("\n---", firstBreak);
  return end < 0 ? "" : text.slice(firstBreak + 1, end);
}

function fieldValue(front: string, key: string): string | undefined {
  const lines = front.split(/\r?\n/);
  const prefix = key + ":";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.startsWith(prefix)) continue;
    const raw = line.slice(prefix.length).trim();
    if (raw === ">" || raw === "|") {
      const parts: string[] = [];
      for (let child = index + 1; child < lines.length; child += 1) {
        const next = lines[child]!;
        if (/^[A-Za-z0-9_-]+:\s*/.test(next)) break;
        if (!next.trim()) {
          if (parts.length > 0) parts.push("");
          continue;
        }
        if (!/^\s+/.test(next)) break;
        parts.push(next.trim());
      }
      return parts.join(" ").replace(/\s+/g, " ").trim();
    }
    return unquote(raw);
  }
  return undefined;
}

function metadataVersion(front: string): string | undefined {
  const match = front.match(/^\s+version:\s*(.+)$/m);
  return match ? unquote(match[1]!) : undefined;
}

function normalize(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function inside(candidate: string, root: string): boolean {
  const value = normalize(candidate);
  const base = normalize(root);
  return value === base || value.startsWith(base + path.sep);
}

function discoverSource(root: string, source: MatlabSkillSource): MatlabSkillRecord[] {
  const catalogRoot = path.join(root, source, "skills-catalog");
  let realCatalog: string;
  try {
    if (!fs.statSync(catalogRoot).isDirectory()) return [];
    realCatalog = fs.realpathSync(catalogRoot);
  } catch {
    return [];
  }

  const records: MatlabSkillRecord[] = [];
  const groups = fs.readdirSync(realCatalog, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const groupEntry of groups) {
    const groupPath = path.join(realCatalog, groupEntry.name);
    for (const skillEntry of fs.readdirSync(groupPath, { withFileTypes: true })) {
      if (!skillEntry.isDirectory()) continue;
      const candidate = path.join(groupPath, skillEntry.name, "SKILL.md");
      let realFile: string;
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        realFile = fs.realpathSync(candidate);
      } catch {
        continue;
      }
      if (!inside(realFile, realCatalog)) continue;

      const text = fs.readFileSync(realFile, "utf8");
      const front = frontMatter(text);
      const id = fieldValue(front, "name")?.trim();
      if (!id) continue;
      const description = fieldValue(front, "description")?.trim() ?? "";
      const version = metadataVersion(front);

      records.push({
        id,
        source,
        group: groupEntry.name,
        description,
        ...(version ? { version } : {}),
        filePath: realFile
      });
    }
  }
  return records;
}

export class MatlabSkillCatalog {
  readonly #records: Map<string, MatlabSkillRecord>;

  constructor(readonly toolkitRoot: string) {
    const records = [
      ...discoverSource(toolkitRoot, "matlab"),
      ...discoverSource(toolkitRoot, "simulink")
    ];
    this.#records = new Map();
    for (const record of records) {
      const key = record.id.toLowerCase();
      if (this.#records.has(key)) {
        throw new Error(`Duplicate MathWorks skill id "${record.id}".`);
      }
      this.#records.set(key, record);
    }
  }

  list(options: {
    source?: MatlabSkillSource;
    group?: string;
    query?: string;
    limit?: number;
  } = {}): MatlabSkillDescriptor[] {
    const query = options.query?.trim().toLowerCase();
    const group = options.group?.trim().toLowerCase();
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);

    return [...this.#records.values()]
      .filter((record) => !options.source || record.source === options.source)
      .filter((record) => !group || record.group.toLowerCase() === group)
      .filter((record) => {
        if (!query) return true;
        const haystack = [record.id, record.group, record.description]
          .join("\n")
          .toLowerCase();
        return query.split(/\s+/).filter(Boolean).every((token) => haystack.includes(token));
      })
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, limit)
      .map(({ filePath: _filePath, ...descriptor }) => ({ ...descriptor }));
  }

  count(): number {
    return this.#records.size;
  }

  read(id: string): MatlabSkillDescriptor & { content: string } {
    const record = this.#records.get(id.trim().toLowerCase());
    if (!record) throw new Error(`Unknown MathWorks skill "${id}".`);

    const realFile = fs.realpathSync(record.filePath);
    const sourceRoot = fs.realpathSync(
      path.join(this.toolkitRoot, record.source, "skills-catalog")
    );
    if (!inside(realFile, sourceRoot)) {
      throw new Error(`MathWorks skill "${id}" resolves outside its skill catalog.`);
    }

    const content = fs.readFileSync(realFile, "utf8");
    const { filePath: _filePath, ...descriptor } = record;
    return { ...descriptor, content };
  }
}
