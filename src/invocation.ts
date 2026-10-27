/**
 * Builds the `opencode run` command line recorded in each job's invocation
 * snapshot and executed by the supervisor.
 *
 * v2 flags only: the 1.x plugin used --attach, --port, --command, --share,
 * --variant and --dangerously-skip-permissions, none of which exist in
 * OpenCode v2. Headless permission handling is --auto, which approves
 * everything not explicitly denied (deny rules always win).
 */
import { findOpencode } from "./config.js"
import type { Job, JobInvocation, JobRunSpec } from "./jobs.js"

export function getJobRun(job: Job): JobRunSpec {
  if (job.run?.prompt?.trim()) return job.run
  throw new Error(`Job "${job.slug}" has no run.prompt. Update the job to add one.`)
}

export function buildInvocation(job: Job): JobInvocation {
  const run = getJobRun(job)
  const command = findOpencode()
  const args = ["run"]

  if (run.serverUrl) {
    args.push("--server", run.serverUrl)
  }
  if (run.autoApprove !== false) {
    args.push("--auto")
  }
  if (run.model) {
    args.push("--model", run.model)
  }
  if (run.agent) {
    args.push("--agent", run.agent)
  }
  if (run.title) {
    args.push("--title", run.title)
  }
  if (run.format) {
    args.push("--format", run.format)
  }
  for (const file of run.files ?? []) {
    args.push("--file", file)
  }
  if (run.session) {
    args.push("--session", run.session)
  }
  if (run.continue) {
    args.push("--continue")
  }

  args.push("--", run.prompt)
  return { command, args }
}

export function invocationsEqual(a: JobInvocation | undefined, b: JobInvocation | undefined): boolean {
  if (!a || !b) return a === b
  return a.command === b.command && a.args.length === b.args.length && a.args.every((v, i) => v === b.args[i])
}
