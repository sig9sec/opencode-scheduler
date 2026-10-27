/**
 * Shared paths, scope derivation, and runtime binary resolution.
 *
 * All durable state lives under ~/.config/opencode/scheduler, scoped by the
 * job's working directory so jobs from different projects never collide.
 */
import { accessSync, constants, existsSync, mkdirSync, readFileSync } from "fs"
import { homedir, platform } from "os"
import { basename, dirname, join, resolve } from "path"

export const IS_LINUX = platform() === "linux"

export const OPENCODE_CONFIG = join(homedir(), ".config", "opencode")
export const SCHEDULER_DIR = join(OPENCODE_CONFIG, "scheduler")
export const SCOPES_DIR = join(SCHEDULER_DIR, "scopes")
export const SUPERVISOR_PATH = join(SCHEDULER_DIR, "supervisor.js")
export const SCHEDULER_CONFIG_PATH = join(OPENCODE_CONFIG, "opencode-scheduler.json")
export const SYSTEMD_USER_DIR = join(homedir(), ".config", "systemd", "user")
export const SCHEDULER_LOGS_DIR = join(OPENCODE_CONFIG, "logs", "scheduler")

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

export function normalizeWorkdirPath(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return homedir()
  return resolve(trimmed)
}

function fnv1a64Hex(input: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  for (const byte of Buffer.from(input, "utf8")) {
    hash ^= BigInt(byte)
    hash = (hash * prime) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, "0")
}

/**
 * Scope ids are derived from the normalized working directory: a readable
 * label plus a short hash so different projects with the same basename do
 * not collide. Keep this stable: it is baked into systemd unit names.
 */
export function deriveScopeId(workdir: string): string {
  const normalized = normalizeWorkdirPath(workdir)
  const base = slugify(basename(normalized)) || "workspace"
  const suffix = fnv1a64Hex(normalized).slice(0, 12)
  return `${base}-${suffix}`
}

export function scopeDir(scopeId: string): string {
  return join(SCOPES_DIR, scopeId)
}

export function scopeJobsDir(scopeId: string): string {
  return join(scopeDir(scopeId), "jobs")
}

export function scopeLocksDir(scopeId: string): string {
  return join(scopeDir(scopeId), "locks")
}

export function scopeRunsDir(scopeId: string): string {
  return join(scopeDir(scopeId), "runs")
}

export function scopeLogsDir(scopeId: string): string {
  return join(SCHEDULER_LOGS_DIR, scopeId)
}

export function jobFilePath(scopeId: string, slug: string): string {
  return join(scopeJobsDir(scopeId), `${slug}.json`)
}

export function scopedLogPath(scopeId: string, slug: string): string {
  return join(scopeLogsDir(scopeId), `${slug}.log`)
}

export function ensureScopeStorage(scopeId: string): void {
  ensureDir(scopeJobsDir(scopeId))
  ensureDir(scopeLocksDir(scopeId))
  ensureDir(scopeRunsDir(scopeId))
  ensureDir(scopeLogsDir(scopeId))
}

// === Plugin configuration (~/.config/opencode/opencode-scheduler.json) ===

export interface SchedulerEnvConfig {
  /** OPENCODE_* variables to keep when launching scheduled runs. */
  preserve?: string[]
  /** Extra variables to set for scheduled runs. */
  set?: Record<string, string>
}

export interface SchedulerConfig {
  env?: SchedulerEnvConfig
}

export function loadSchedulerConfig(): SchedulerConfig {
  try {
    const raw = readFileSync(SCHEDULER_CONFIG_PATH, "utf-8")
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as SchedulerConfig
    }
  } catch {
    // Missing or invalid config is not an error.
  }
  return {}
}

// === Runtime binary resolution ===

const BASE_PATH_ENTRIES = ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]

/**
 * PATH used inside scheduler units and supervisor runs. Schedulers start
 * with a minimal environment, so the directories holding the opencode and
 * node binaries must be included explicitly.
 */
export function enhancedPath(extraDirs: (string | undefined)[]): string {
  const parts = [...extraDirs.filter((d): d is string => Boolean(d)), ...BASE_PATH_ENTRIES]
  return Array.from(new Set(parts)).join(":")
}

/** Resolve a command through PATH: the inherited PATH first, then the standard locations. */
export function which(command: string): string | null {
  if (command.includes("/")) {
    return isExecutable(command) ? command : null
  }
  const searchPath = [process.env.PATH, ...BASE_PATH_ENTRIES].filter((p): p is string => Boolean(p)).join(":")
  for (const dir of new Set(searchPath.split(":"))) {
    const candidate = join(dir, command)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const COMMON_OPENCODE_LOCATIONS = [
  "/usr/local/bin/opencode",
  join(homedir(), ".local", "bin", "opencode"),
  // Legacy 1.x install location.
  join(homedir(), ".opencode", "bin", "opencode"),
]

/**
 * Find the opencode binary to invoke for scheduled runs. Recorded as an
 * absolute path in each job's invocation snapshot so the scheduler does not
 * depend on the invoking shell's PATH.
 */
export function findOpencode(): string {
  const override = process.env.OPENCODE_SCHEDULER_OPENCODE_PATH?.trim()
  if (override) return override

  // The opencode server usually hosts this plugin, so its own executable
  // directory is the best hint even when PATH is unusual.
  try {
    const besideSelf = join(dirname(process.execPath), "opencode")
    if (existsSync(besideSelf)) return besideSelf
    if (basename(process.execPath) === "opencode") return process.execPath
  } catch {
    // Ignore, fall through.
  }

  const resolved = which("opencode")
  if (resolved) return resolved

  for (const candidate of COMMON_OPENCODE_LOCATIONS) {
    if (existsSync(candidate)) return candidate
  }

  return "opencode"
}

/**
 * Find a JavaScript runtime able to run the supervisor script. The absolute
 * path is recorded in scheduler units; `null` means scheduled runs fall
 * back to invoking opencode directly, without supervision.
 */
export function findSupervisorRuntime(): string | null {
  const override = process.env.OPENCODE_SCHEDULER_NODE_PATH?.trim()
  if (override) return override

  // Only use the current interpreter when it is a real node/bun binary.
  // Inside the opencode server, process.execPath is the opencode binary
  // itself, which must not be used to run scripts.
  const selfName = basename(process.execPath)
  if ((selfName === "node" || selfName === "bun") && existsSync(process.execPath)) {
    return process.execPath
  }

  for (const command of ["node", "bun"]) {
    const resolved = which(command)
    if (resolved) return resolved
  }

  for (const candidate of ["/usr/bin/node", "/usr/local/bin/node", "/usr/bin/bun", "/usr/local/bin/bun"]) {
    if (existsSync(candidate)) return candidate
  }

  return null
}
