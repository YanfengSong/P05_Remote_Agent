import fs from "node:fs";
import path from "node:path";

export type ReferenceRootDescriptor = {
  id: string;
  label: string;
  root: string;
};

export type ReferenceRootView = {
  id: string;
  label: string;
};

type ReferenceRootFile = {
  version: 1;
  references: ReferenceRootDescriptor[];
};

function normalize(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function idBase(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 52);
  return "ref-" + (slug || "reference");
}

export class ReferenceManager {
  readonly #filePath: string;
  #references: ReferenceRootDescriptor[];

  constructor(filePath: string) {
    this.#filePath = filePath;
    this.#references = this.#load();
  }

  #load(): ReferenceRootDescriptor[] {
    if (!fs.existsSync(this.#filePath)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.#filePath, "utf8"));
    } catch {
      throw new Error("Reference root registry must be valid JSON.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Reference root registry must be a JSON object.");
    }
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1 || !Array.isArray(record.references)) {
      throw new Error("Reference root registry must use version 1.");
    }

    const ids = new Set<string>();
    const roots = new Set<string>();
    return record.references.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`Reference root entry ${index} must be an object.`);
      }
      const value = item as Record<string, unknown>;
      const id = typeof value.id === "string" ? value.id.trim() : "";
      const label = typeof value.label === "string" ? value.label.trim() : "";
      const root = typeof value.root === "string" ? value.root.trim() : "";
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) {
        throw new Error(`Reference root entry ${index} has an invalid id.`);
      }
      if (!label) throw new Error(`Reference root entry ${index} requires a label.`);
      if (!path.isAbsolute(root)) {
        throw new Error(`Reference root "${id}" must use an absolute path.`);
      }
      const idKey = id.toLowerCase();
      const rootKey = normalize(root);
      if (ids.has(idKey)) throw new Error(`Duplicate reference root id "${id}".`);
      if (roots.has(rootKey)) throw new Error(`Duplicate reference root path for "${id}".`);
      ids.add(idKey);
      roots.add(rootKey);
      return { id, label, root: path.resolve(root) };
    });
  }

  #save(): void {
    fs.mkdirSync(path.dirname(this.#filePath), { recursive: true });
    const payload: ReferenceRootFile = {
      version: 1,
      references: this.#references.map((entry) => ({ ...entry }))
    };
    const temp = this.#filePath + ".tmp-" + process.pid;
    fs.writeFileSync(temp, JSON.stringify(payload, null, 2) + "\n", "utf8");
    fs.rmSync(this.#filePath, { force: true });
    fs.renameSync(temp, this.#filePath);
  }

  list(): ReferenceRootView[] {
    return this.#references.map(({ id, label }) => ({ id, label }));
  }

  localList(): ReferenceRootDescriptor[] {
    return this.#references.map((entry) => ({ ...entry }));
  }

  get(id: string): ReferenceRootDescriptor {
    const key = id.trim().toLowerCase();
    const match = this.#references.find((entry) => entry.id.toLowerCase() === key);
    if (!match) throw new Error(`Reference root "${id}" is not authorized.`);
    return { ...match };
  }

  add(root: string): ReferenceRootDescriptor {
    const candidate = root.trim();
    if (!candidate) throw new Error("Reference root is required.");
    if (!path.isAbsolute(candidate)) throw new Error("Reference root must be an absolute path.");

    const resolved = path.resolve(candidate);
    let stat: fs.Stats;
    let realRoot: string;
    try {
      stat = fs.statSync(resolved);
      realRoot = fs.realpathSync(resolved);
    } catch {
      throw new Error("Reference root does not exist or cannot be resolved.");
    }
    if (!stat.isDirectory()) throw new Error("Reference root is not a directory.");

    const existing = this.#references.find(
      (entry) => normalize(entry.root) === normalize(realRoot)
    );
    if (existing) return { ...existing };

    const label = path.basename(realRoot) || realRoot;
    const base = idBase(label);
    const used = new Set(this.#references.map((entry) => entry.id.toLowerCase()));
    let id = base;
    for (let index = 2; used.has(id.toLowerCase()); index += 1) {
      const suffix = `-${index}`;
      id = base.slice(0, Math.max(1, 64 - suffix.length)) + suffix;
    }

    const entry = { id, label, root: realRoot };
    this.#references.push(entry);
    this.#save();
    return { ...entry };
  }

  remove(id: string): ReferenceRootDescriptor {
    const key = id.trim().toLowerCase();
    const index = this.#references.findIndex((entry) => entry.id.toLowerCase() === key);
    if (index < 0) throw new Error(`Reference root "${id}" is not authorized.`);
    const [removed] = this.#references.splice(index, 1);
    this.#save();
    return { ...removed! };
  }
}
