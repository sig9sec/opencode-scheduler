/**
 * Scheduler backends: systemd --user timers and unit files, with cron as a
 * fallback where systemd user sessions are unavailable.
 *
 * All shell interactions use execFileSync with argument arrays; no string
 * interpolation into shell commands.
 */
import { execFileSync } from "child_process"
import { existsSync, readdirSync, unlinkSync, writeFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import {
  SYSTEMD_USER_DIR,
  enhancedPath,
  ensureDir,
  ensureScopeStorage,
  findOpencode,
  findSupervisorRuntime,
  jobFilePath,
  scopedLogPath,
  SUPERVISOR_PATH,
} from "./config.js"
import { cronToSystemdCalendars } from "./cron.js"
import type { Job } from "./jobs.js"
import { ensureSupervisorScript } from "./supervisor.js"

export type SchedulerBackend = "systemd" | "cron"

export interface InstallResult {
  backend: SchedulerBackend
  /** false when no JS runtime was found and opencode runs unsupervised. */
  supervised: boolean
}

function run(command: string, args: string[], options: { check: boolean }): void {
  if (options.check) {
    execFileSync(command, args, { stdio: ["ignore", "ignore", "pipe"] })
  } else {
    try {
      execFileSync(command, args, { stdio: ["ignore", "ignore", "pipe"] })
    } catch {
      // Best effort.
    }
  }
}

// === Backend detection ===

export function isSystemdUserAvailable(): boolean {
  try {
    execFileSync("systemctl", ["--user", "show-environment"], { stdio: ["ignore", "ignore", "pipe"] })
    return true
  } catch {
    return false
  }
}

export function isCronAvailable(): boolean {
  try {
    execFileSync("crontab", ["-l"], { stdio: ["ignore", "ignore", "pipe"] })
    return true
  } catch (error) {
    // `crontab -l` exits 1 with "no crontab for <user>" when cron works but
    // the table is empty; anything else means crontab is unusable.
    const status = typeof error === "object" && error !== null && "status" in error ? (error as { status?: number }).status : undefined
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error ? (error as { stderr?: Buffer }).stderr : undefined
    const message = stderr ? stderr.toString("utf-8") : ""
    return status === 1 && /no crontab/i.test(message)
  }
}

export function resolveSchedulerBackend(): SchedulerBackend {
  if (isSystemdUserAvailable()) return "systemd"
  if (isCronAvailable()) return "cron"
  throw new Error(
    "No supported scheduler backend found: systemd --user is unavailable and crontab is not installed. " +
      "Install cron, or run from a session with a systemd user manager (not a bare SSH or container session)."
  )
}

// === systemd ===

function unitBaseName(job: Job): string {
  return `opencode-job-${job.scopeId}-${job.slug}`
}

function escapeSystemdArg(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function timeoutBackstopSeconds(job: Job): number | null {
  if (!job.timeoutSeconds || job.timeoutSeconds <= 0) return null
  // The supervisor enforces the real timeout (SIGTERM then SIGKILL); this is
  // just a backstop that also reaps anything the supervisor leaves behind.
  return job.timeoutSeconds + 120
}

export function createSystemdService(job: Job, execStart: string[]): string {
  const logPath = scopedLogPath(job.scopeId, job.slug)
  const quotedExecStart = execStart.map((arg) => `"${escapeSystemdArg(arg)}"`).join(" ")

  const pathEntries = enhancedPath([safeDirname(findOpencode()), safeDirname(findSupervisorRuntime())])

  const lines = [
    "[Unit]",
    `Description=OpenCode Job: ${job.name}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=oneshot",
    `WorkingDirectory=${job.workdir}`,
    `Environment=HOME=${homedir()}`,
    `Environment=PATH=${pathEntries}`,
    `ExecStart=${quotedExecStart}`,
    `StandardOutput=append:${logPath}`,
    `StandardError=append:${logPath}`,
  ]

  const backstop = timeoutBackstopSeconds(job)
  if (backstop) lines.push(`TimeoutStartSec=${backstop}`)

  lines.push("", "[Install]", "WantedBy=default.target", "")
  return lines.join("\n")
}

export function createSystemdTimer(job: Job): string {
  const calendars = cronToSystemdCalendars(job.schedule)
  const lines = [
    "[Unit]",
    `Description=Timer for OpenCode Job: ${job.name}`,
    "",
    "[Timer]",
    ...calendars.map((calendar) => `OnCalendar=${calendar}`),
    "Persistent=true",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ]
  return lines.join("\n")
}

function safeDirname(path: string | undefined | null): string | undefined {
  if (!path || !path.includes("/")) return undefined
  return path.slice(0, path.lastIndexOf("/"))
}

function installSystemdJob(job: Job, execStart: string[]): void {
  ensureDir(SYSTEMD_USER_DIR)
  ensureScopeStorage(job.scopeId)

  const base = unitBaseName(job)
  writeFileSync(join(SYSTEMD_USER_DIR, `${base}.service`), createSystemdService(job, execStart))
  writeFileSync(join(SYSTEMD_USER_DIR, `${base}.timer`), createSystemdTimer(job))

  run("systemctl", ["--user", "daemon-reload"], { check: true })
  run("systemctl", ["--user", "enable", "--now", `${base}.timer`], { check: true })
}

function uninstallSystemdJob(job: Job): void {
  const base = unitBaseName(job)
  run("systemctl", ["--user", "stop", `${base}.timer`], { check: false })
  run("systemctl", ["--user", "disable", `${base}.timer`], { check: false })

  for (const suffix of [".service", ".timer"]) {
    const path = join(SYSTEMD_USER_DIR, base + suffix)
    if (existsSync(path)) {
      try {
        unlinkSync(path)
      } catch {
        // Already gone.
      }
    }
  }

  run("systemctl", ["--user", "daemon-reload"], { check: false })
}

// === cron fallback ===

const CRON_MANAGED_PREFIX = "opencode-scheduler"

function cronBlockId(job: Job): string {
  return `${job.scopeId}:${job.slug}`
}

function cronBlockStart(id: string): string {
  return `# BEGIN ${CRON_MANAGED_PREFIX} ${id}`
}

function cronBlockEnd(id: string): string {
  return `# END ${CRON_MANAGED_PREFIX} ${id}`
}

function shellEscapeDoubleQuoted(value: string): string {
  return value.replace(/(["\\$`])/g, "\\$1")
}

function readUserCrontab(): string {
  return execFileSync("crontab", ["-l"], { encoding: "utf-8" })
}

function writeUserCrontab(content: string): void {
  const normalized = content.trim()
  execFileSync("crontab", ["-"], { input: normalized ? `${normalized}\n` : "" })
}

function stripManagedCronBlocks(content: string, blockIds: Set<string>): { content: string; removed: number } {
  const lines = content ? content.split(/\r?\n/) : []
  const retained: string[] = []
  const prefix = `# BEGIN ${CRON_MANAGED_PREFIX} `
  const endPrefix = `# END ${CRON_MANAGED_PREFIX} `
  let removed = 0

  for (let index = 0; index < lines.length; ) {
    const line = lines[index]
    if (!line.startsWith(prefix)) {
      retained.push(line)
      index += 1
      continue
    }

    const id = line.slice(prefix.length).trim()
    let endIndex = lines.length - 1
    for (let probe = index + 1; probe < lines.length; probe += 1) {
      if (lines[probe] === `${endPrefix}${id}`) {
        endIndex = probe
        break
      }
    }

    if (blockIds.has(id)) {
      removed += 1
    } else {
      for (let keep = index; keep <= endIndex; keep += 1) retained.push(lines[keep])
    }

    index = endIndex + 1
  }

  return { content: retained.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd(), removed }
}

function createCronEntry(job: Job, command: string[]): string {
  const pathValue = enhancedPath([safeDirname(findOpencode()), safeDirname(findSupervisorRuntime())])
  const escaped = command.map(shellEscapeDoubleQuoted)
  const logPath = shellEscapeDoubleQuoted(scopedLogPath(job.scopeId, job.slug))
  return `${job.schedule} PATH="${pathValue}" ${escaped.map((a) => `"${a}"`).join(" ")} >> "${logPath}" 2>&1`
}

function installCronJob(job: Job, command: string[]): void {
  ensureScopeStorage(job.scopeId)

  const blockId = cronBlockId(job)
  const current = readUserCrontab()
  const stripped = stripManagedCronBlocks(current, new Set([blockId]))
  const block = [cronBlockStart(blockId), createCronEntry(job, command), cronBlockEnd(blockId)].join("\n")
  writeUserCrontab([stripped.content.trim(), block].filter(Boolean).join("\n\n"))
}

function uninstallCronJob(job: Job): void {
  let current: string
  try {
    current = readUserCrontab()
  } catch {
    return
  }
  const stripped = stripManagedCronBlocks(current, new Set([cronBlockId(job)]))
  if (stripped.removed > 0) writeUserCrontab(stripped.content)
}

// === Cross-backend install/uninstall ===

function supervisedCommand(job: Job): string[] {
  const runtime = findSupervisorRuntime()
  if (!runtime) return []
  ensureSupervisorScript()
  return [runtime, SUPERVISOR_PATH, jobFilePath(job.scopeId, job.slug)]
}

function directCommand(job: Job): string[] {
  if (!job.invocation) throw new Error("Job has no invocation snapshot")
  return [job.invocation.command, ...job.invocation.args]
}

/**
 * The command line the scheduler (or a manual run) executes for a job:
 * the supervisor when a JS runtime is available, otherwise opencode
 * directly without supervision.
 */
export function buildSchedulerCommand(job: Job): { command: string[]; supervised: boolean } {
  const supervised = supervisedCommand(job)
  if (supervised.length > 0) return { command: supervised, supervised: true }
  return { command: directCommand(job), supervised: false }
}

export function installJob(job: Job): InstallResult {
  if (!job.invocation) throw new Error("Job has no invocation snapshot")

  const { command, supervised } = buildSchedulerCommand(job)

  if (isSystemdUserAvailable()) {
    installSystemdJob(job, command)
    return { backend: "systemd", supervised }
  }

  if (isCronAvailable()) {
    installCronJob(job, command)
    return { backend: "cron", supervised }
  }

  throw new Error(
    "No supported scheduler backend found: systemd --user is unavailable and crontab is not installed."
  )
}

export function uninstallJob(job: Job): void {
  uninstallSystemdJob(job)
  uninstallCronJob(job)
}

/** List installed opencode job timer unit names (used by cleanup). */
export function listSystemdJobUnits(): string[] {
  if (!existsSync(SYSTEMD_USER_DIR)) return []
  try {
    return readdirSync(SYSTEMD_USER_DIR).filter((name) => /^opencode-job-.*\.(service|timer)$/.test(name)).sort()
  } catch {
    return []
  }
}
