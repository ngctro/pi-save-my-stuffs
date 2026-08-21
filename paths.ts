import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type BackupPath = {
  readonly src: string;
  readonly dest: string;
  readonly watch: boolean;
};

export type ExtensionConfig = {
  repo: string;
  branch: string;
  enabled: boolean;
  debounceMinutes: number;
  extraPaths: string[];
};

export const DEFAULT_CONFIG: ExtensionConfig = {
  repo: "",
  branch: "main",
  enabled: true,
  debounceMinutes: 2,
  extraPaths: [],
};

export const ALLOWLIST: readonly BackupPath[] = [
  { src: "settings.json", dest: "settings.json", watch: true },
  { src: "extensions", dest: "extensions", watch: true },
  { src: "skills", dest: "skills", watch: true },
  { src: "themes", dest: "themes", watch: true },
  { src: "prompts", dest: "prompts", watch: true },
];

export function defaultStateDir(home?: string): string {
  return path.join(home ?? os.homedir(), ".pi", "save-my-stuffs");
}

export function defaultAgentDir(home?: string): string {
  return path.join(home ?? os.homedir(), ".pi", "agent");
}

export function loadConfig(stateDir: string): ExtensionConfig | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(stateDir, "config.json"), "utf8");
  } catch {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const obj = data as Record<string, unknown>;
  const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  return {
    repo: isNonEmptyString(obj.repo) ? obj.repo : DEFAULT_CONFIG.repo,
    branch: isNonEmptyString(obj.branch) ? obj.branch : DEFAULT_CONFIG.branch,
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : DEFAULT_CONFIG.enabled,
    debounceMinutes:
      typeof obj.debounceMinutes === "number" &&
      Number.isFinite(obj.debounceMinutes) &&
      obj.debounceMinutes > 0
        ? obj.debounceMinutes
        : DEFAULT_CONFIG.debounceMinutes,
    extraPaths:
      Array.isArray(obj.extraPaths) && obj.extraPaths.every((e): e is string => typeof e === "string")
        ? obj.extraPaths
        : DEFAULT_CONFIG.extraPaths,
  };
}

export function saveConfig(stateDir: string, config: ExtensionConfig): void {
  fs.mkdirSync(stateDir, { recursive: true });
  atomicWrite(path.join(stateDir, "config.json"), JSON.stringify(config, null, 2));
}

export function atomicWrite(file: string, contents: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}
