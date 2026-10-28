/**
 * Tool surface exposed to agents. Eight flat tools, all returning plain
 * text content; errors are returned as text so the agent can recover.
 */
import { spawn } from "child_process"
import { closeSync, existsSync, openSync, readdirSync, readFileSync, rmSync } from "fs"
import { join } from "path"
import type { Plugin } from "@opencode/plugin"
import {
  deriveScopeId,
  ensureDir,
  ensureScopeStorage,
  normalizeWorkdirPath,
  scopedLogPath,
  SCHEDULER_LOGS_DIR,
  SCOPES_DIR,
  scopeJobsDir,
  scopeLocksDir,
  scopeRunsDir,
  SYSTEMD_USER_DIR,
} from "./config.js"
import { describeCron, validateCronExpression } from "./cron.js"
import { buildInvocation, getJobRun } from "./invocation.js"
import {
  deleteJobFile,
  findJobByName,
  loadAllJobsAcrossScopes,
  loadAllScopedJobs,
  loadScopedJob,
  normalizeRunSpec,
  saveJob,
  updateJobRecord,
  type Job,
  type JobRunSpec,
} from "./jobs.js"
import { buildSchedulerCommand, installJob, jobScheduledState, uninstallJob, listSystemdJobUnits } from "./backends.js"
import { ensureSupervisorScript } from "./supervisor.js"

type ToolEditor = Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0]

const jsonSchema = {
  object<T extends Record<string, unknown>>(properties: T, required: string[]) {
    return { type: "object" as const, properties, required, additionalProperties: false }
  },
  string(description: string) {
    return { type: "string" as const, description }
  },
  stringArray(description: string) {
    return { type: "array" as const, items: { type: "string" as const }, description }
  },
  number(description: string) {
    return { type: "number" as const, description }
  },
  boolean(description: string) {
    return { type: "boolean" as const, description }
  },
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function scopeIdFor(locationDir: string, workdir?: string): { scopeId: string; workdir: string } {
  const normalized = normalizeWorkdirPath(workdir?.trim() || locationDir)
  return { scopeId: deriveScopeId(normalized), workdir: normalized }
}

// === Formatting ===

function promptPreview(run: JobRunSpec): string {
  const prompt = run.prompt.trim()
  return prompt.slice(0, 100) + (prompt.length > 100 ? "..." : "")
}

function runSummary(run: JobRunSpec): string[] {
  const lines = [`Prompt: ${promptPreview(run)}`]
  if (run.model) lines.push(`Model: ${run.model}`)
  if (run.agent) lines.push(`Agent: ${run.agent}`)
  if (run.title) lines.push(`Title: ${run.title}`)
  if (run.format) lines.push(`Format: ${run.format}`)
  if (run.files?.length) lines.push(`Files: ${run.files.join(", ")}`)
  if (run.session) lines.push(`Session: ${run.session}`)
  if (run.continue) lines.push("Continue: true")
  if (run.autoApprove === false) lines.push("Auto-approve: disabled (runs may block on permission asks)")
  if (run.serverUrl) lines.push(`Server: ${run.serverUrl}`)
  return lines
}

function jobStatusLines(job: Job): string[] {
  const lines: string[] = []
  if (job.lastRunAt) lines.push(`Last Run: ${job.lastRunAt} (${job.lastRunSource ?? "unknown source"})`)
  if (job.lastRunStatus) lines.push(`Last Run Status: ${job.lastRunStatus}`)
  if (job.lastRunExitCode !== undefined) lines.push(`Last Exit Code: ${job.lastRunExitCode}`)
  if (job.lastRunError) lines.push(`Last Error: ${job.lastRunError}`)
  return lines
}

function formatJobDetails(job: Job): string {
  const lines = [
    `Job: ${job.name}`,
    `Slug: ${job.slug}`,
    `Schedule: ${job.schedule} (${describeCron(job.schedule)})`,
    `Working Directory: ${job.workdir}`,
    `Scope: ${job.scopeId}`,
  ]
  try {
    lines.push(...runSummary(getJobRun(job)))
  } catch {
    lines.push("Prompt: (missing)")
  }
  if (job.timeoutSeconds) lines.push(`Timeout: ${job.timeoutSeconds}s`)
  if (job.source) lines.push(`Source: ${job.source}`)
  lines.push(`Created: ${job.createdAt}`)
  if (job.updatedAt) lines.push(`Updated: ${job.updatedAt}`)
  lines.push(...jobStatusLines(job))
  return lines.join("\n")
}

function tailFile(path: string, lines: number, maxChars: number): string | null {
  if (!existsSync(path)) return null
  try {
    const content = readFileSync(path, "utf-8")
    const tail = content.split(/\r?\n/).slice(-lines).join("\n")
    return tail.length > maxChars ? tail.slice(-maxChars) : tail
  } catch {
    return null
  }
}

// === Tool implementations ===

interface ScheduleJobArgs {
  name: string
  schedule: string
  prompt: string
  model?: string
  agent?: string
  title?: string
  format?: string
  files?: string[]
  session?: string
  continue?: boolean
  autoApprove?: boolean
  serverUrl?: string
  timeoutSeconds?: number
  workdir?: string
  source?: string
}

async function scheduleJob(args: ScheduleJobArgs, locationDir: string): Promise<string> {
  const slug = args.source ? `${args.source}-${slugify(args.name)}` : slugify(args.name)
  if (!slug) return `Error: "${args.name}" does not produce a usable job slug.`

  const { scopeId, workdir } = scopeIdFor(locationDir, args.workdir)

  if (loadScopedJob(scopeId, slug)) {
    return `Error: job "${slug}" already exists in this workspace scope (${scopeId}). Delete it first or use a different name.`
  }

  let run: JobRunSpec
  try {
    run = normalizeRunSpec(args)
  } catch (error) {
    return `Error: ${errorMessage(error)}`
  }

  try {
    validateCronExpression(args.schedule)
  } catch (error) {
    return `Error: invalid schedule: ${errorMessage(error)}`
  }

  if (args.timeoutSeconds !== undefined && (!Number.isFinite(args.timeoutSeconds) || args.timeoutSeconds < 0)) {
    return "Error: timeoutSeconds must be a non-negative integer."
  }

  const job: Job = {
    scopeId,
    slug,
    name: args.name,
    schedule: args.schedule,
    workdir,
    run,
    timeoutSeconds: args.timeoutSeconds,
    source: args.source,
    createdAt: new Date().toISOString(),
  }

  try {
    job.invocation = buildInvocation(job)
  } catch (error) {
    return `Error: failed to build the opencode invocation: ${errorMessage(error)}`
  }

  try {
    saveJob(job)
    const install = installJob(job)
    const notes: string[] = []
    if (!install.supervised) {
      notes.push(
        "Warning: no node/bun runtime found, so this job runs without supervision " +
          "(no overlap protection, metadata, or timeout). Install node to get full supervision."
      )
    }
    if (install.backend === "cron") {
      notes.push("Cron note: missed runs during sleep are not replayed; systemd would catch up via Persistent=true.")
    }

    return [
      `Scheduled "${args.name}"`,
      "",
      `Schedule: ${args.schedule} (${describeCron(args.schedule)})`,
      `Backend: ${install.backend}${install.supervised ? " (supervised)" : ""}`,
      `Working Directory: ${workdir}`,
      ...runSummary(run),
      ...(notes.length ? ["", ...notes] : []),
      "",
      'Try: "run ' + args.name + ' now", "show my jobs", "delete job ' + args.name + '"',
    ].join("\n")
  } catch (error) {
    deleteJobFile(job)
    return `Error: failed to schedule job: ${errorMessage(error)}`
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

interface ListJobsArgs {
  allScopes?: boolean
  scopeRoot?: string
  source?: string
}

async function listJobs(args: ListJobsArgs, locationDir: string): Promise<string> {
  const scopeId = args.allScopes
    ? undefined
    : scopeIdFor(locationDir, args.scopeRoot).scopeId

  let jobs = scopeId ? loadAllScopedJobs(scopeId) : loadAllJobsAcrossScopes()
  if (args.source) {
    jobs = jobs.filter((j) => j.source === args.source || j.slug.startsWith(`${args.source}-`))
  }

  if (jobs.length === 0) {
    return args.allScopes
      ? "No scheduled jobs in any scope."
      : 'No scheduled jobs in this workspace.\n\nTry: "Schedule a daily job at 9am to ..."'
  }

  const entries = jobs.map((job, index) => {
    let preview: string
    try {
      preview = promptPreview(getJobRun(job))
    } catch {
      preview = "(missing prompt)"
    }
    return [
      `${index + 1}. ${job.name} (${job.slug})`,
      `   ${job.schedule} - ${describeCron(job.schedule)}`,
      `   ${preview}`,
    ].join("\n")
  })

  const header = args.allScopes ? `Scheduled Jobs (all ${new Set(jobs.map((j) => j.scopeId)).size} scopes)` : "Scheduled Jobs"
  return `${header}\n\n${entries.join("\n\n")}`
}

async function getJob(name: string, locationDir: string): Promise<string> {
  const job = findJobByName(name, { scopeId: scopeIdFor(locationDir).scopeId, allScopes: false })
  if (!job) return `Error: job "${name}" not found in this workspace. Use list_jobs with allScopes to search everywhere.`
  return formatJobDetails(job)
}

interface UpdateJobArgs {
  name: string
  schedule?: string
  prompt?: string
  model?: string
  agent?: string
  title?: string
  format?: string
  files?: string[]
  session?: string
  continue?: boolean
  autoApprove?: boolean
  serverUrl?: string
  timeoutSeconds?: number
  workdir?: string
}

async function updateJob(args: UpdateJobArgs, locationDir: string): Promise<string> {
  const job = findJobByName(args.name, { scopeId: scopeIdFor(locationDir).scopeId, allScopes: true })
  if (!job) return `Error: job "${args.name}" not found.`

  let currentRun: JobRunSpec
  try {
    currentRun = getJobRun(job)
  } catch {
    return `Error: job "${job.slug}" has no recoverable run prompt. Recreate the job.`
  }

  // Apply updates. An empty string clears an optional field.
  const next: Record<string, unknown> = { ...currentRun }
  const optionalStrings = ["model", "agent", "title", "session", "serverUrl"] as const
  for (const field of optionalStrings) {
    const value = args[field]
    if (value === undefined) continue
    if (value.trim() === "") delete next[field]
    else next[field] = value.trim()
  }
  if (args.prompt !== undefined) next.prompt = args.prompt
  if (args.files !== undefined) next.files = args.files.map((f) => f.trim()).filter(Boolean)
  if (args.continue !== undefined) next.continue = args.continue === true ? true : undefined
  if (args.autoApprove !== undefined) next.autoApprove = args.autoApprove === true ? undefined : false
  if (args.format !== undefined) {
    if (args.format !== "json" && args.format !== "default") return "Error: format must be 'default' or 'json'."
    next.format = args.format
  }

  let run: JobRunSpec
  try {
    run = normalizeRunSpec(next)
  } catch (error) {
    return `Error: ${errorMessage(error)}`
  }

  const updates: Partial<Job> = { run }

  if (args.schedule !== undefined) {
    try {
      validateCronExpression(args.schedule)
    } catch (error) {
      return `Error: invalid schedule: ${errorMessage(error)}`
    }
    updates.schedule = args.schedule
  }

  if (args.timeoutSeconds !== undefined) {
    if (!Number.isFinite(args.timeoutSeconds) || args.timeoutSeconds < 0) {
      return "Error: timeoutSeconds must be a non-negative integer."
    }
    updates.timeoutSeconds = args.timeoutSeconds
  }

  let scopeChanged = false
  if (args.workdir !== undefined && args.workdir.trim()) {
    const { scopeId, workdir } = scopeIdFor(locationDir, args.workdir)
    scopeChanged = scopeId !== job.scopeId
    updates.scopeId = scopeId
    updates.workdir = workdir
  }

  const updated: Job = { ...job, ...updates, updatedAt: new Date().toISOString() }
  try {
    updated.invocation = buildInvocation(updated)
  } catch (error) {
    return `Error: failed to build the opencode invocation: ${errorMessage(error)}`
  }

  // A timer the user disabled stays disabled across updates; an absent or
  // enabled one is (re)enabled as usual.
  const wasScheduled = jobScheduledState(job) !== "disabled"

  try {
    if (scopeChanged) uninstallJob(job)
    saveJob(updated)
    installJob(updated, { enable: wasScheduled })
    if (scopeChanged) deleteJobFile(job)
    return [`Updated job "${updated.name}"`, "", `Schedule: ${updated.schedule} (${describeCron(updated.schedule)})`, ...runSummary(run)].join("\n")
  } catch (error) {
    // Best-effort rollback to the previous definition and schedule.
    try {
      saveJob(job)
      installJob(job, { enable: wasScheduled })
    } catch {
      // Rollback is best effort; the error below is the real signal.
    }
    return `Error: failed to update job: ${errorMessage(error)}`
  }
}

async function deleteJob(name: string, locationDir: string): Promise<string> {
  const job = findJobByName(name, { scopeId: scopeIdFor(locationDir).scopeId, allScopes: true })
  if (!job) return `Error: job "${name}" not found.`

  uninstallJob(job)
  deleteJobFile(job)
  return `Deleted job "${job.name}" (scope ${job.scopeId}). Logs and run history were kept; use cleanup_global to remove them.`
}

async function runJobNow(name: string, locationDir: string): Promise<string> {
  const job = findJobByName(name, { scopeId: scopeIdFor(locationDir).scopeId, allScopes: true })
  if (!job) return `Error: job "${name}" not found. Use list_jobs to see available jobs.`

  if (!job.invocation) {
    try {
      job.invocation = buildInvocation(job)
      saveJob(job)
    } catch (error) {
      return `Error: job has no invocation and none could be built: ${errorMessage(error)}`
    }
  }

  ensureDir(SCHEDULER_LOGS_DIR)
  ensureScopeStorage(job.scopeId)
  const logPath = scopedLogPath(job.scopeId, job.slug)

  const { command, supervised } = buildSchedulerCommand(job)

  try {
    if (supervised) {
      ensureSupervisorScript()
      const child = spawn(command[0], [...command.slice(1), "--source", "manual"], {
        cwd: job.workdir,
        detached: true,
        stdio: "ignore",
      })
      child.unref()
      return [
        `Triggered "${job.name}" (manual, fire-and-forget).`,
        `Logs: ${logPath}`,
        "",
        'Ask again in a minute with "show logs for ' + job.name + '" to see the result.',
      ].join("\n")
    }

    // Unsupervised fallback: run opencode directly, append output to the log.
    const fd = openSync(logPath, "a")
    try {
      const child = spawn(command[0], command.slice(1), {
        cwd: job.workdir,
        detached: true,
        stdio: ["ignore", fd, fd],
      })
      child.unref()
      updateJobRecord(job, {
        lastRunAt: new Date().toISOString(),
        lastRunSource: "manual",
        lastRunStatus: "running",
        lastRunExitCode: undefined,
        lastRunError: undefined,
      })
    } finally {
      // The child inherits the descriptor; this copy can be closed.
      closeSync(fd)
    }
    return `Triggered "${job.name}" (manual, unsupervised).\nLogs: ${logPath}`
  } catch (error) {
    return `Error: failed to start job "${job.name}": ${errorMessage(error)}`
  }
}

async function jobLogs(name: string, lines: number | undefined, locationDir: string): Promise<string> {
  const job = findJobByName(name, { scopeId: scopeIdFor(locationDir).scopeId, allScopes: true })
  if (!job) return `Error: job "${name}" not found.`

  const logPath = scopedLogPath(job.scopeId, job.slug)
  const tailLines = typeof lines === "number" && Number.isFinite(lines) ? Math.max(1, Math.min(5000, Math.floor(lines))) : 200
  const logs = tailFile(logPath, tailLines, 20000)

  if (!logs) return `No logs yet for "${job.name}". The job may not have run.\nLog path: ${logPath}`
  return `Logs for ${job.name} (last ${tailLines} lines)\n\n${logs}`
}

interface CleanupArgs {
  confirm?: boolean
  includeHistory?: boolean
}

function listFiles(dir: string, suffix: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(suffix))
      .map((name) => join(dir, name))
      .sort()
  } catch {
    return []
  }
}

async function cleanupGlobal(args: CleanupArgs): Promise<string> {
  const dryRun = args.confirm !== true
  const includeHistory = args.includeHistory === true

  const scopeIds = (() => {
    try {
      return readdirSync(SCOPES_DIR).filter((name) => existsSync(join(SCOPES_DIR, name, "jobs"))).sort()
    } catch {
      return []
    }
  })()

  const errors: string[] = []
  const removed: Record<string, number> = { jobs: 0, locks: 0, runs: 0, logs: 0, units: 0 }

  const targets: { label: keyof typeof removed; files: string[] }[] = [
    { label: "jobs", files: scopeIds.flatMap((id) => listFiles(scopeJobsDir(id), ".json")) },
    { label: "locks", files: scopeIds.flatMap((id) => listFiles(scopeLocksDir(id), ".json")) },
    ...(includeHistory
      ? [
          { label: "runs" as const, files: scopeIds.flatMap((id) => listFiles(scopeRunsDir(id), ".jsonl")) },
          {
            label: "logs" as const,
            files: (() => {
              try {
                return readdirSync(SCHEDULER_LOGS_DIR)
                  .flatMap((id) => listFiles(join(SCHEDULER_LOGS_DIR, id), ".log"))
              } catch {
                return []
              }
            })(),
          },
        ]
      : []),
    { label: "units", files: listSystemdJobUnits().map((name) => join(SYSTEMD_USER_DIR, name)) },
  ]

  if (!dryRun) {
    for (const job of loadAllJobsAcrossScopes()) {
      try {
        uninstallJob(job)
      } catch (error) {
        errors.push(`failed to uninstall ${job.slug}: ${errorMessage(error)}`)
      }
    }
  }

  const lines = [`Global scheduler cleanup: ${dryRun ? "DRY RUN (nothing deleted)" : "EXECUTED"}`, ""]

  for (const target of targets) {
    if (dryRun) {
      removed[target.label] = target.files.filter((path) => existsSync(path)).length
    } else {
      for (const path of target.files) {
        if (!existsSync(path)) continue
        try {
          rmSync(path, { force: true })
          removed[target.label] += 1
        } catch (error) {
          errors.push(`failed to remove ${path}: ${errorMessage(error)}`)
        }
      }
    }
    lines.push(`- ${target.label}: ${removed[target.label]}`)
  }

  if (!includeHistory) lines.push("- run history/logs: skipped (set includeHistory=true)")
  if (errors.length) lines.push("", "Errors:", ...errors.map((e) => `- ${e}`))
  if (dryRun) lines.push("", "Re-run with confirm=true to apply.")

  return lines.join("\n")
}

// === Registration ===

export function registerTools(editor: ToolEditor, locationDir: string): void {
  const execute = <T>(handler: (args: T) => Promise<string>) => async (input: unknown) => ({
    content: await handler(input as T),
  })

  editor.add({
    name: "schedule_job",
    description:
      "Schedule a recurring job that runs an `opencode run` prompt via a systemd user timer (or cron fallback). " +
      "Jobs are scoped to a working directory.",
    input: jsonSchema.object(
      {
        name: jsonSchema.string("Short name for the job, e.g. 'standing desk search'"),
        schedule: jsonSchema.string("Cron expression: '0 9 * * *' (daily 9am), '0 */6 * * *' (every 6h), '30 8 * * 1' (Mon 8:30am)"),
        prompt: jsonSchema.string("The prompt to run at each tick. Reference @scheduled-job-best-practices for reliable patterns."),
        model: jsonSchema.string("Model in provider/model[#variant] form (maps to --model)"),
        agent: jsonSchema.string("Agent to use (maps to --agent)"),
        title: jsonSchema.string("Session title (maps to --title)"),
        format: jsonSchema.string("Output format: 'default' or 'json' (maps to --format)"),
        files: jsonSchema.stringArray("Files/directories to attach (each maps to --file)"),
        session: jsonSchema.string("Session id to continue (maps to --session)"),
        continue: jsonSchema.boolean("Continue the latest session (maps to --continue)"),
        autoApprove: jsonSchema.boolean("Auto-approve permissions not explicitly denied (default true; maps to --auto)"),
        serverUrl: jsonSchema.string("OpenCode server URL to connect to instead of the local one (maps to --server)"),
        timeoutSeconds: jsonSchema.number("Hard runtime limit in seconds; 0 or omitted disables it"),
        workdir: jsonSchema.string("Working directory to run from (defaults to this workspace)"),
        source: jsonSchema.string("Origin label used for filtering, e.g. 'marketplace'"),
      },
      ["name", "schedule", "prompt"]
    ),
    execute: execute<ScheduleJobArgs>((args) => scheduleJob(args, locationDir)),
  })

  editor.add({
    name: "list_jobs",
    description: "List scheduled jobs for this workspace (or across all workspaces with allScopes).",
    input: jsonSchema.object(
      {
        allScopes: jsonSchema.boolean("List jobs across all workspace scopes"),
        scopeRoot: jsonSchema.string("Directory whose scope to list (defaults to this workspace)"),
        source: jsonSchema.string("Filter by source label"),
      },
      []
    ),
    execute: execute<ListJobsArgs>((args) => listJobs(args, locationDir)),
  })

  editor.add({
    name: "get_job",
    description: "Get details, schedule, and last-run status for a scheduled job.",
    input: jsonSchema.object({ name: jsonSchema.string("The job name or slug") }, ["name"]),
    execute: execute<{ name: string }>((args) => getJob(args.name, locationDir)),
  })

  editor.add({
    name: "update_job",
    description: "Update a scheduled job (schedule, prompt, model, flags, timeout, workdir). Pass an empty string to clear an optional field.",
    input: jsonSchema.object(
      {
        name: jsonSchema.string("The job name or slug"),
        schedule: jsonSchema.string("New cron expression"),
        prompt: jsonSchema.string("New prompt"),
        model: jsonSchema.string("New model in provider/model[#variant] form"),
        agent: jsonSchema.string("New agent"),
        title: jsonSchema.string("New session title"),
        format: jsonSchema.string("New output format: 'default' or 'json'"),
        files: jsonSchema.stringArray("New list of files/directories to attach"),
        session: jsonSchema.string("New session id to continue"),
        continue: jsonSchema.boolean("Continue the latest session"),
        autoApprove: jsonSchema.boolean("Enable/disable --auto for runs"),
        serverUrl: jsonSchema.string("New server URL"),
        timeoutSeconds: jsonSchema.number("New hard runtime limit in seconds (0 disables)"),
        workdir: jsonSchema.string("New working directory (moves the job to that scope)"),
      },
      ["name"]
    ),
    execute: execute<UpdateJobArgs>((args) => updateJob(args, locationDir)),
  })

  editor.add({
    name: "delete_job",
    description: "Remove a scheduled job: scheduler units and the job definition. Logs and history are kept.",
    input: jsonSchema.object({ name: jsonSchema.string("The job name or slug to delete") }, ["name"]),
    execute: execute<{ name: string }>((args) => deleteJob(args.name, locationDir)),
  })

  editor.add({
    name: "run_job",
    description: "Trigger a scheduled job immediately (fire-and-forget). Output is appended to the job's log.",
    input: jsonSchema.object({ name: jsonSchema.string("The job name or slug") }, ["name"]),
    execute: execute<{ name: string }>((args) => runJobNow(args.name, locationDir)),
  })

  editor.add({
    name: "job_logs",
    description: "Show the latest output lines from a job's log file.",
    input: jsonSchema.object(
      {
        name: jsonSchema.string("The job name or slug"),
        lines: jsonSchema.number("Number of lines from the end of the log (default 200)"),
      },
      ["name"]
    ),
    execute: execute<{ name: string; lines?: number }>((args) => jobLogs(args.name, args.lines, locationDir)),
  })

  editor.add({
    name: "cleanup_global",
    description:
      "Remove all scheduler artifacts across every scope: job definitions, locks, scheduler units, and optionally logs and run history. Dry run unless confirm=true.",
    input: jsonSchema.object(
      {
        confirm: jsonSchema.boolean("Set true to actually delete (default false = dry run)"),
        includeHistory: jsonSchema.boolean("Also remove run history and logs (default false)"),
      },
      []
    ),
    execute: execute<CleanupArgs>((args) => cleanupGlobal(args)),
  })
}
