/**
 * Job model and scoped file storage.
 *
 * Jobs are plain JSON files under ~/.config/opencode/scheduler/scopes so
 * they stay inspectable and can be read by the supervisor, which runs
 * outside the opencode server.
 */
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import {
  deriveScopeId,
  ensureDir,
  ensureScopeStorage,
  jobFilePath,
  normalizeWorkdirPath,
  scopeJobsDir,
  SCOPES_DIR,
} from "./config.js"
import { validateCronExpression } from "./cron.js"

export type RunFormat = "default" | "json"

/**
 * What a job runs: a prompt for `opencode run` plus optional flag mappings.
 * Prompt-only by design; v2 has no command mode.
 */
export interface JobRunSpec {
  prompt: string
  /** Model in provider/model[#variant] form (maps to --model). */
  model?: string
  /** Agent to use (maps to --agent). */
  agent?: string
  /** Session title (maps to --title). */
  title?: string
  /** Output format (maps to --format). */
  format?: RunFormat
  /** Files to attach (each maps to one --file). */
  files?: string[]
  /** Continue a specific session (maps to --session). */
  session?: string
  /** Continue the latest session (maps to --continue). */
  continue?: boolean
  /**
   * Auto-approve permissions not explicitly denied (maps to --auto).
   * Defaults to true for scheduled runs: they are headless and must never
   * block on a permission prompt. Explicit deny rules always stay enforced.
   */
  autoApprove?: boolean
  /** Connect to a remote OpenCode server instead of the local one (--server). */
  serverUrl?: string
}

/** Snapshot of the exact command line the scheduler executes. */
export interface JobInvocation {
  command: string
  args: string[]
}

export interface Job {
  scopeId: string
  slug: string
  name: string
  schedule: string
  workdir: string
  run?: JobRunSpec
  invocation?: JobInvocation
  /** Hard runtime limit in seconds; 0 or undefined disables it. */
  timeoutSeconds?: number
  /** Optional origin label, e.g. a marketplace or tool name. */
  source?: string
  createdAt: string
  updatedAt?: string
  lastRunAt?: string
  lastRunExitCode?: number
  lastRunError?: string
  lastRunSource?: "manual" | "scheduled"
  lastRunStatus?: "running" | "success" | "failed"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// === Run spec normalization ===

export function normalizeRunSpec(raw: unknown): JobRunSpec {
  if (!isRecord(raw)) throw new Error("run spec must be an object")

  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : ""
  if (!prompt) throw new Error("Job must have a non-empty run.prompt")

  const run: JobRunSpec = { prompt }
  const runRecord = run as unknown as Record<string, unknown>

  const optionalString = (key: keyof JobRunSpec): void => {
    const value = raw[key as string]
    if (typeof value === "string" && value.trim()) {
      runRecord[key] = value.trim()
    }
  }

  optionalString("model")
  optionalString("agent")
  optionalString("title")
  optionalString("session")
  optionalString("serverUrl")

  if (raw.format === "json" || raw.format === "default") run.format = raw.format

  if (Array.isArray(raw.files)) {
    const files = raw.files.map((f) => String(f).trim()).filter(Boolean)
    if (files.length) run.files = files
  }

  if (raw.continue === true) run.continue = true
  if (raw.autoApprove === false) run.autoApprove = false

  return run
}

// === Job normalization ===

function normalizeInvocation(raw: unknown): JobInvocation | undefined {
  if (!isRecord(raw)) return undefined
  if (typeof raw.command !== "string" || !raw.command.trim()) return undefined
  if (!Array.isArray(raw.args)) return undefined
  return { command: raw.command, args: raw.args.map((v) => String(v)) }
}

export function normalizeJob(raw: unknown): Job | null {
  if (!isRecord(raw)) return null
  if (typeof raw.slug !== "string" || typeof raw.name !== "string" || typeof raw.schedule !== "string") return null

  const workdir = typeof raw.workdir === "string" && raw.workdir.trim() ? normalizeWorkdirPath(raw.workdir) : homedir()

  const job: Job = {
    scopeId: typeof raw.scopeId === "string" && raw.scopeId.trim() ? raw.scopeId : deriveScopeId(workdir),
    slug: raw.slug,
    name: raw.name,
    schedule: raw.schedule,
    workdir,
    source: typeof raw.source === "string" && raw.source.trim() ? raw.source : undefined,
    timeoutSeconds:
      typeof raw.timeoutSeconds === "number" && Number.isFinite(raw.timeoutSeconds) && raw.timeoutSeconds >= 0
        ? Math.floor(raw.timeoutSeconds)
        : undefined,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
    lastRunAt: typeof raw.lastRunAt === "string" ? raw.lastRunAt : undefined,
    lastRunExitCode: typeof raw.lastRunExitCode === "number" ? raw.lastRunExitCode : undefined,
    lastRunError: typeof raw.lastRunError === "string" ? raw.lastRunError : undefined,
    lastRunSource: raw.lastRunSource === "manual" || raw.lastRunSource === "scheduled" ? raw.lastRunSource : undefined,
    lastRunStatus:
      raw.lastRunStatus === "running" || raw.lastRunStatus === "success" || raw.lastRunStatus === "failed"
        ? raw.lastRunStatus
        : undefined,
  }

  // v1 jobs stored the prompt (and optionally attachUrl) at the top level.
  const legacyPrompt = typeof raw.prompt === "string" ? raw.prompt.trim() : ""
  const legacyAttach = typeof raw.attachUrl === "string" && raw.attachUrl.trim() ? raw.attachUrl.trim() : undefined

  if (isRecord(raw.run)) {
    job.run = normalizeRunSpec(raw.run)
  } else if (legacyPrompt) {
    const run: JobRunSpec = { prompt: legacyPrompt }
    if (legacyAttach) run.serverUrl = legacyAttach
    job.run = run
  } else {
    // Jobs written before the run spec existed may only carry an invocation.
    const recovered = recoverRunSpecFromInvocation(normalizeInvocation(raw.invocation))
    if (recovered) job.run = recovered
  }

  job.invocation = normalizeInvocation(raw.invocation)
  return job
}

/**
 * Reverse-parse a v1 invocation snapshot into a run spec. Used to migrate
 * jobs created by the 1.x plugin, which stored flags that no longer exist
 * (--attach, --port, --share, --variant, --command,
 * --dangerously-skip-permissions).
 */
export function recoverRunSpecFromInvocation(invocation: JobInvocation | undefined): JobRunSpec | undefined {
  if (!invocation) return undefined
  const args = invocation.args.filter((a) => a !== "run")

  let prompt = ""
  const run: JobRunSpec = { prompt: "" }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    switch (arg) {
      case "--":
        prompt = args.slice(i + 1).join(" ")
        i = args.length
        break
      case "--model":
        if (next) run.model = next
        i++
        break
      case "--variant":
        if (next) run.model = run.model ? `${run.model}#${next}` : next
        i++
        break
      case "--agent":
        if (next) run.agent = next
        i++
        break
      case "--title":
        if (next) run.title = next
        i++
        break
      case "--format":
        if (next === "json" || next === "default") run.format = next
        i++
        break
      case "--file":
        if (next) run.files = [...(run.files ?? []), next]
        i++
        break
      case "--session":
        if (next) run.session = next
        i++
        break
      case "--continue":
        run.continue = true
        break
      case "--auto":
      case "--dangerously-skip-permissions":
        run.autoApprove = true
        break
      case "--attach":
      case "--server":
        if (next) run.serverUrl = next
        i++
        break
      case "--command":
        // v1 command mode has no v2 equivalent; keep the text as the prompt.
        if (next) prompt = next
        i++
        break
      default:
        if (!arg.startsWith("--") && arg && !prompt) prompt = arg
        break
    }
  }

  run.prompt = prompt.trim()
  if (!run.prompt) return undefined
  return run
}

// === Storage ===

function readJobFile(path: string): Job | null {
  if (!existsSync(path)) return null
  try {
    return normalizeJob(JSON.parse(readFileSync(path, "utf-8")))
  } catch {
    return null
  }
}

export function loadScopedJob(scopeId: string, slug: string): Job | null {
  ensureScopeStorage(scopeId)
  return readJobFile(jobFilePath(scopeId, slug))
}

export function loadAllScopedJobs(scopeId: string): Job[] {
  ensureScopeStorage(scopeId)
  const dir = scopeJobsDir(scopeId)
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"))
  } catch {
    return []
  }
  return files
    .map((f) => readJobFile(join(dir, f)))
    .filter((j): j is Job => j !== null)
}

export function listScopeIds(): string[] {
  if (!existsSync(SCOPES_DIR)) return []
  try {
    return readdirSync(SCOPES_DIR).filter((name) => existsSync(join(SCOPES_DIR, name, "jobs"))).sort()
  } catch {
    return []
  }
}

export function loadAllJobsAcrossScopes(): Job[] {
  return listScopeIds().flatMap((scopeId) => loadAllScopedJobs(scopeId))
}

export function saveJob(job: Job): Job {
  const normalized: Job = { ...job, scopeId: job.scopeId || deriveScopeId(job.workdir) }
  ensureScopeStorage(normalized.scopeId)
  writeFileSync(jobFilePath(normalized.scopeId, normalized.slug), JSON.stringify(normalized, null, 2) + "\n")
  return normalized
}

export function deleteJobFile(job: Job): void {
  const path = jobFilePath(job.scopeId, job.slug)
  if (existsSync(path)) {
    try {
      unlinkSync(path)
    } catch {
      // Already gone.
    }
  }
}

/**
 * Reload the latest job record from disk and merge updates into it, so
 * metadata written by the supervisor is not clobbered by a stale copy.
 */
export function updateJobRecord(job: Job, updates: Partial<Job>): Job {
  const latest = loadScopedJob(job.scopeId, job.slug) ?? job
  const updated: Job = { ...latest, ...updates, scopeId: job.scopeId, updatedAt: new Date().toISOString() }
  return saveJob(updated)
}

// === Lookup ===

export interface FindJobOptions {
  scopeId?: string
  allScopes?: boolean
}

function matches(job: Job, name: string, slug: string): boolean {
  const lowered = name.toLowerCase()
  return (
    job.slug === name ||
    job.slug.endsWith(`-${slug}`) ||
    job.name.toLowerCase() === lowered ||
    job.name.toLowerCase().includes(lowered)
  )
}

export function findJobByName(name: string, options: FindJobOptions): Job | null {
  const trimmed = name.trim()
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")

  const scopeId = options.scopeId ?? ""
  if (scopeId) {
    const local = loadScopedJob(scopeId, slug) ?? loadScopedJob(scopeId, trimmed)
    if (local) return local
    const scoped = loadAllScopedJobs(scopeId).find((j) => matches(j, trimmed, slug))
    if (scoped) return scoped
  }

  if (options.allScopes) {
    const any = loadAllJobsAcrossScopes().find((j) => matches(j, trimmed, slug))
    if (any) return any
  }

  return null
}

// === Validation helpers used by tools ===

export function validateJobSchedule(schedule: string): void {
  validateCronExpression(schedule)
}

export function validateTimeoutSeconds(timeout: number | undefined): void {
  if (timeout === undefined) return
  if (!Number.isFinite(timeout) || timeout < 0 || Math.floor(timeout) !== timeout) {
    throw new Error("timeoutSeconds must be a non-negative integer")
  }
}

export function ensureStorageRoot(): void {
  ensureDir(SCOPES_DIR)
}
