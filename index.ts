/**
 * Server-side tasks plugin: gives the model a tool to inspect and manage the
 * background shell tasks the shell tool creates.
 *
 * Why it talks HTTP to its own server: the server plugin context exposes no
 * shell management API (`ctx.shell` only has a `create.before` hook), and
 * `@opencode/client` is not resolvable from a plugin module. The server
 * registers its URL and password in `service.json`, so the plugin reads that
 * file and calls the documented shell endpoints with Basic auth. Identity is
 * verified by comparing the server's reported pid with `process.pid`, which
 * prevents managing another server's shells when this plugin runs inside a
 * private (`--standalone`) server.
 */

import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const AUTH_USER = "opencode"
const REQUEST_TIMEOUT_MS = 10000
const MAX_ANCESTOR_DEPTH = 16
const DEFAULT_OUTPUT_LIMIT = 20000
const MAX_OUTPUT_LIMIT = 200000
const DESCRIPTION_LIMIT = 72

const ACTIONS = ["list", "status", "output", "kill"]

/**
 * Error text the shell tool reports when a task's record was removed while it
 * was still running, which is what a user-initiated termination looks like.
 */
const SHELL_GONE = /Shell\.NotFoundError|Shell command not found/i

/**
 * A background task's completion notice is delivered as a message that resumes
 * an idle session, so a model must not keep the turn alive with sleep/poll
 * loops. The note goes into the tasks tool description and is also appended to
 * the shell tool description, where background tasks are started.
 */
const WAKE_NOTE =
  "Background task completion resumes this session automatically; do not run sleep, wait, or polling commands to keep the turn alive."

// --- service discovery ------------------------------------------------------

function serviceFileNames(channel) {
  const names = []
  const normalized = typeof channel === "string" ? channel.replace(/[^a-zA-Z0-9._-]/g, "-") : ""
  if (normalized && !["latest", "dev", "beta", "next", "local"].includes(normalized)) {
    names.push(`service-${normalized}.json`)
  }
  names.push("service.json")
  return [...new Set(names)]
}

function readRegistration(ctx) {
  const stateDir = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state")
  const directory = join(stateDir, "opencode")
  for (const name of serviceFileNames(ctx.app?.channel)) {
    const file = join(directory, name)
    try {
      if (!existsSync(file)) continue
      const parsed = JSON.parse(readFileSync(file, "utf8"))
      if (typeof parsed?.url !== "string" || typeof parsed?.password !== "string") continue
      return { url: parsed.url.replace(/\/+$/, ""), password: parsed.password, pid: parsed.pid }
    } catch {
      // try the next candidate
    }
  }
  return undefined
}

// --- location scoping -------------------------------------------------------
//
// Shell endpoints are location scoped. The server takes the location from the
// `x-opencode-directory` header (what the generated client sends) and also
// accepts it as a deepObject `location[directory]` query parameter. A plain
// `directory` parameter does nothing: the request then falls back to the
// server's own working directory, which makes a registry that does track the
// task look empty. All three forms are sent so the call keeps working across
// v2 builds; an unrecognised parameter is ignored.

function withLocation(path, directory) {
  if (typeof directory !== "string" || directory.length === 0) return path
  const encoded = encodeURIComponent(directory)
  const separator = path.includes("?") ? "&" : "?"
  return `${path}${separator}location[directory]=${encoded}&directory=${encoded}`
}

function locationHeaders(directory) {
  if (typeof directory !== "string" || directory.length === 0) return {}
  return { "x-opencode-directory": encodeURIComponent(directory) }
}

// --- formatting -------------------------------------------------------------

function flatten(value, limit) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return ""
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${seconds % 60 ? `${seconds % 60}s` : ""}`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ""}`
}

function statusMark(status) {
  if (status === "running") return "running"
  return status
}

function formatTask(info, now) {
  const parts = [`id=${info.id}`, statusMark(info.status)]
  if (info.status === "running" && info.time?.started) {
    parts.push(`elapsed=${formatDuration(now - info.time.started)}`)
  }
  if (typeof info.exit === "number" && info.status !== "running") parts.push(`exit=${info.exit}`)
  if (info.metadata?.background === true) parts.push("started-in-background")
  const sessionID = info.metadata?.sessionID
  if (typeof sessionID === "string" && sessionID.length > 0) parts.push(`session=${sessionID}`)
  parts.push(`cwd=${info.cwd}`)
  return `- ${parts.join(" ")}\n  cmd: ${flatten(info.command, DESCRIPTION_LIMIT)}\n  log: ${info.file}`
}

/**
 * The server drops a task's record as soon as it exits, and its registry never
 * lists tasks spawned by the shell tool at all, so the plugin has to fall back
 * to two things it can still rely on: the captured output kept on disk at
 * `<data>/opencode/shell/<location>/<id>.out`, and the liveness of the pid
 * reported by the `shell.created` event.
 */
function isAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // A process we do not own answers EPERM, which still means it exists.
    return error?.code === "EPERM"
  }
}

/**
 * Match a process command line against the command string the task reported.
 * The server spawns `<shell> -c <command>` in its own session, but a shell that
 * can replace itself with a simple command leaves that command's own argv
 * behind (`sleep 240` instead of `bash -c sleep 240`), so both shapes count.
 * The shell consumes quoting before it execs, so one more comparison with
 * quotes removed catches those cases.
 */
function matchesCommand(parts, command) {
  if (parts.length >= 3 && parts[1] === "-c" && parts[2] === command) return true
  if (parts.length === 0) return false
  const joined = parts.join(" ")
  if (joined === command) return true
  const unquoted = (text) => text.replace(/["']/g, "")
  return unquoted(joined) === unquoted(command)
}

/**
 * Verify that a pid the server or the event stream reported still belongs to
 * the task: it must still be its own process-group and session leader, and it
 * must not predate the task's start time.
 */
function verifiedProcessGroup(pid, startedAt) {
  if (!Number.isFinite(pid) || pid <= 0) return undefined
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    // "pid (comm) state ppid pgrp session ..."; comm may contain spaces or
    // parentheses, so parse from the closing one.
    const tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    if (Number(tail[2]) !== pid || Number(tail[3]) !== pid) return undefined
    if (Number.isFinite(startedAt) && statSync(`/proc/${pid}`).ctimeMs < startedAt - 5000) return undefined
    return pid
  } catch {
    return undefined
  }
}

/**
 * Locate the process group of a task the server no longer tracks, so a kill
 * still reaches the whole command tree. Tasks are spawned as their own session
 * and process-group leaders, so a known pid is verified directly and otherwise
 * /proc is scanned for a single group leader running the task's command.
 *
 * /proc only exists on Linux; elsewhere this returns undefined and the caller
 * reports the command instead of guessing.
 */
function taskProcessGroup(command, startedAt, pid) {
  const known = verifiedProcessGroup(pid, startedAt)
  if (known) return known
  if (typeof command !== "string" || command.length === 0) return undefined
  let names
  try {
    names = readdirSync("/proc")
  } catch {
    return undefined // not a /proc filesystem
  }
  const matches = []
  for (const name of names) {
    const candidate = Number(name)
    if (!Number.isInteger(candidate) || candidate <= 0) continue

    let parts
    try {
      parts = readFileSync(`/proc/${candidate}/cmdline`, "utf8").split("\0").filter(Boolean)
    } catch {
      continue // process vanished or is not readable
    }
    if (!matchesCommand(parts, command)) continue
    if (verifiedProcessGroup(candidate, startedAt) === undefined) continue
    matches.push(candidate)
  }
  return matches.length === 1 ? matches[0] : undefined
}

function retainedLogRoots() {
  const roots = []
  const dataHome = process.env.XDG_DATA_HOME
  if (typeof dataHome === "string" && dataHome.length > 0) roots.push(join(dataHome, "opencode", "shell"))
  roots.push(join(homedir(), ".local", "share", "opencode", "shell"))
  return [...new Set(roots)]
}

function findRetainedLog(taskID) {
  if (typeof taskID !== "string" || taskID.length === 0) return undefined
  for (const root of retainedLogRoots()) {
    let entries
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      continue // no shell directory under this data root
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const file = join(root, entry.name, `${taskID}.out`)
      try {
        if (statSync(file).isFile()) return file
      } catch {
        // not in this location's directory; keep looking
      }
    }
  }
  return undefined
}

/**
 * Read a byte window straight from a retained log, mirroring the server's
 * cursor semantics. Returns the total size and the offset after the window.
 */
function readLogWindow(file, cursor, limit) {
  const handle = openSync(file, "r")
  try {
    const size = fstatSync(handle).size
    const start = Math.max(0, Math.min(cursor, size))
    const length = Math.max(0, Math.min(limit, size - start))
    if (length === 0) return { size, output: "", next: start }
    const buffer = Buffer.allocUnsafe(length)
    const read = readSync(handle, buffer, 0, length, start)
    return { size, output: buffer.subarray(0, read).toString("utf8"), next: start + read }
  } finally {
    closeSync(handle)
  }
}

function missingTaskMessage(taskID, directory, cached, retained) {
  const lines = [`Task ${taskID} is no longer known to the server at ${directory}.`]
  const file = cached?.file ?? retained
  if (cached) {
    lines.push("", "Last observed state:")
    if (cached.status) lines.push(`  status: ${cached.status}`)
    if (cached.command) lines.push(`  command: ${flatten(cached.command, 200)}`)
    if (file) lines.push(`  log: ${file}`)
    if (typeof cached.exit === "number") lines.push(`  exit: ${cached.exit}`)
  } else if (file) {
    lines.push("", `Retained log: ${file}`)
  } else {
    lines.push("It may have finished long ago, or never existed at this working directory.")
  }
  if (file) {
    lines.push(
      "",
      "The retained log still holds the output: call 'output' to page through it, or use the read/grep tools on that path.",
    )
  }
  return lines.join("\n")
}

function formatStatus(info, now) {
  const lines = [
    `Task ${info.id}`,
    `  status:  ${statusMark(info.status)}${info.status === "running" ? "" : typeof info.exit === "number" ? ` (exit ${info.exit})` : ""}`,
    `  command: ${flatten(info.command, 200)}`,
    `  cwd:     ${info.cwd}`,
    `  shell:   ${info.shell}`,
    `  log:     ${info.file}`,
  ]
  if (info.pid) lines.push(`  pid:     ${info.pid}`)
  if (info.time?.started) {
    lines.push(`  started: ${new Date(info.time.started).toISOString()}`)
    if (info.status === "running") {
      lines.push(`  elapsed: ${formatDuration(now - info.time.started)}`)
    } else if (info.time.completed) {
      lines.push(`  ran for: ${formatDuration(info.time.completed - info.time.started)}`)
    }
  }
  const sessionID = info.metadata?.sessionID
  if (typeof sessionID === "string" && sessionID.length > 0) lines.push(`  session: ${sessionID}`)
  return lines.join("\n")
}

// --- plugin -----------------------------------------------------------------

export default {
  id: "tasks",
  async setup(ctx) {
    // Cache the registration and identity check; re-resolve if a call fails,
    // which covers a service restart picking a new port.
    let registration
    let verifiedPid

    const resetConnection = () => {
      registration = undefined
      verifiedPid = undefined
    }

    const resolve = async () => {
      if (registration && verifiedPid === process.pid) return registration
      const found = readRegistration(ctx)
      if (!found) {
        throw new Error(
          "OpenCode service registration not found under the state directory. Task management needs the background service.",
        )
      }
      const info = await fetch(`${found.url}/api/info`, {
        headers: { authorization: bearer(found.password) },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
        .then((response) => (response.ok ? response.json() : undefined))
        .catch(() => undefined)

      if (!info || typeof info.pid !== "number") {
        throw new Error(`OpenCode service at ${found.url} did not answer /api/info.`)
      }
      if (info.pid !== process.pid) {
        throw new Error(
          `The registered service (pid ${info.pid}) is not the server running this session (pid ${process.pid}). ` +
            "Task management is unavailable while using a private server.",
        )
      }
      registration = found
      verifiedPid = info.pid
      return found
    }

    // Remember task details the tool has observed so a later call can still
    // explain what happened after the server drops the record.
    const seen = new Map()
    const remember = (info) => {
      if (!info || typeof info.id !== "string") return
      // Event payloads omit fields instead of nulling them, so drop undefined
      // keys rather than letting a later event erase an earlier observation.
      const patch = {}
      for (const [key, value] of Object.entries(info)) {
        if (value !== undefined) patch[key] = value
      }
      seen.set(info.id, { ...seen.get(info.id), ...patch })
      if (seen.size > 100) {
        for (const key of seen.keys()) {
          if (seen.size <= 80) break
          seen.delete(key)
        }
      }
    }

    const call = async (path, init, directory) => {
      const attempt = async (current) => {
        const response = await fetch(`${current.url}${withLocation(path, directory)}`, {
          ...init,
          headers: {
            authorization: bearer(current.password),
            ...locationHeaders(directory),
            ...(init?.headers ?? {}),
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        if (response.status === 404) {
          const error = new Error("not found")
          error.notFound = true
          throw error
        }
        if (!response.ok) {
          const text = await response.text().catch(() => "")
          const error = new Error(
            `${init?.method ?? "GET"} ${path} failed with ${response.status}${text ? `: ${flatten(text, 200)}` : ""}`,
          )
          error.status = response.status
          throw error
        }
        return response.status === 204 ? undefined : response.json()
      }

      try {
        return await attempt(await resolve())
      } catch (error) {
        // A restarted service gets a new port and password, so re-resolve once
        // for auth and transport failures. A 404 means the task is gone, not
        // that the connection is stale.
        if (error?.notFound) throw error
        if (error?.status === 401 || error?.name === "TimeoutError" || error instanceof TypeError) {
          resetConnection()
          return await attempt(await resolve())
        }
        throw error
      }
    }

    const getTask = async (taskID, directory) => {
      const result = await call(`/api/shell/${encodeURIComponent(taskID)}`, undefined, directory).catch(
        (error) => {
          if (error?.notFound) return undefined
          throw error
        },
      )
      if (result?.data) remember(result.data)
      return result?.data
    }

    // --- kill-notification suppression -------------------------------------
    //
    // Terminating a task always makes the shell tool's completion watcher see
    // its record disappear, so it injects a synthetic session message that
    // resumes the session. That is wanted when a task finishes or fails on its
    // own, but a task the user deliberately killed should only be recorded.
    //
    // The watcher publishes `session.inbox.enqueued` before the shell service
    // publishes `shell.deleted`, so a kill is recognised from either signal:
    // the kill bookkeeping below, or the notification identifying a task whose
    // record is already gone.

    const killed = new Map()
    const killTTL = 10 * 60_000

    const markKilled = (id) => {
      if (typeof id === "string" && id.startsWith("sh_")) killed.set(id, Date.now())
    }

    const wasKilled = (id) => {
      const at = killed.get(id)
      if (at === undefined) return false
      if (Date.now() - at > killTTL) {
        killed.delete(id)
        return false
      }
      return true
    }

    const pruneKilled = () => {
      const now = Date.now()
      for (const [id, at] of killed) {
        if (now - at > killTTL) killed.delete(id)
      }
    }

    // Durable record of terminations, kept out of the session on purpose.
    let killLog = (await ctx.storage.get("kill-log").catch(() => undefined)) ?? []

    const suppress = async (sessionID, inboxID, item) => {
      const payload = item?.payload ?? {}
      const meta = payload.metadata ?? {}
      const shellID = typeof meta.shellID === "string" ? meta.shellID : undefined
      const command = typeof payload.description === "string" ? payload.description : undefined

      // Drop the pending input before the scheduler delivers it. Nothing is
      // written back to the session: any admitted item can be steered into a
      // running turn and reach the model, which is exactly what a deliberate
      // termination must not do. `resume: false` is not enough — it only
      // suppresses scheduling while the session is idle.
      //
      // Best effort: the enqueue event races the delivery loop, so if the item
      // was already delivered this DELETE is a silent no-op and the notice
      // reaches the model. See README section 7.
      await call(
        `/api/session/${encodeURIComponent(sessionID)}/inbox/${encodeURIComponent(inboxID)}`,
        { method: "DELETE" },
      ).catch(() => {})
      if (shellID) killed.delete(shellID)

      killLog = [
        ...killLog,
        { at: new Date().toISOString(), sessionID, shellID, command },
      ].slice(-50)
      void ctx.storage.set("kill-log", killLog).catch(() => {})
    }

    const abort = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
          if (!event || typeof event.type !== "string") continue
          // Index every task as it appears, not just the ones a tool call has
          // looked at, so a lookup still works after the server drops the
          // record on exit.
          if (event.type === "shell.created") {
            remember(event.data?.info)
            continue
          }
          if (event.type === "shell.exited") {
            remember(event.data)
            continue
          }
          if (event.type === "shell.deleted") {
            markKilled(event.data?.id)
            continue
          }
          if (event.type !== "session.inbox.enqueued") continue
          const item = event.data?.item
          if (item?.type !== "synthetic") continue
          const meta = item.payload?.metadata
          if (meta?.source !== "shell") continue
          const shellID = meta.shellID
          if (typeof shellID !== "string") continue

          const state = meta.state
          const gone = state === "error" && SHELL_GONE.test(String(item.payload?.text ?? ""))
          if (!wasKilled(shellID) && state !== "cancelled" && !gone) continue
          void suppress(event.data.sessionID, event.data.inboxID, item)
        }
      } catch {
        // The subscription ends when the plugin unloads or the service stops.
      }
    })()

    const pruneTimer = setInterval(pruneKilled, 60_000)
    pruneTimer.unref?.()

    const locationOf = async (sessionID) => {
      const session = await ctx.session.get({ sessionID })
      const directory = session?.location?.directory
      if (typeof directory !== "string" || directory.length === 0) {
        throw new Error(`Session ${sessionID} has no working directory.`)
      }
      return directory
    }

    // Ancestor chains are cached because subagent tasks share the parent's
    // directory and repeatedly resolve to the same sessions.
    const ancestry = new Map()
    const chainOf = async (sessionID) => {
      if (ancestry.has(sessionID)) return ancestry.get(sessionID)
      const chain = []
      let current = sessionID
      for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && current; depth++) {
        chain.push(current)
        const session = await ctx.session.get({ sessionID: current }).catch(() => undefined)
        current = session?.parentID
        if (!current) break
      }
      ancestry.set(sessionID, chain)
      return chain
    }

    const sessionScope = async (sessionID, tasks) => {
      const owners = [...new Set(tasks.map((task) => task.metadata?.sessionID).filter(Boolean))]
      const included = new Set()
      for (const owner of owners) {
        const chain = await chainOf(owner)
        if (chain.includes(sessionID)) included.add(owner)
      }
      return tasks.filter((task) => {
        const owner = task.metadata?.sessionID
        return typeof owner === "string" && included.has(owner)
      })
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        // Named "tasks" (plural) on purpose: the TUI maps the legacy tool name
        // "task" to its subagent delegation card, which waits for an input
        // field this tool does not have and therefore never shows as finished.
        name: "tasks",
        // Keep the shell tool's own output in charge of foreground results.
        options: { codemode: false },
        description: [
          "Inspect and manage background shell tasks.",
          "Use it to check on long-running commands that were started with the shell tool's background option,",
          "or that were moved to the background after exceeding their wait time.",
          "",
          "Actions:",
          "- 'list': Show running tasks. Defaults to this session and its subagents; scope 'location' covers the whole working directory.",
          "- 'status': Show one task's state, command, timing, exit code, and log path. Required: taskID.",
          "- 'output': Read a task's captured combined stdout/stderr, including while it is still running.",
          "  Reads the most recent bytes by default, so it answers 'how is it going' in one call.",
          "  Use cursor to resume from a known offset, or cursor 0 for the beginning. Required: taskID.",
          "- 'kill': Terminate a running task. Required: taskID.",
          "",
          "Reading output never disturbs the task. list and status also report the log file path,",
          "which the read and grep tools can search directly when a large log needs pattern matching.",
          "Pass the id exactly as reported by 'list' or by the message that moved a command to the background.",
          "When mentioning tasks to the user, prefer the command text over the raw id.",
          "",
          WAKE_NOTE,
          "Finish the turn instead; the completion notice wakes the session when the task ends.",
        ].join("\n"),
        input: {
          type: "object",
          properties: {
            action: { type: "string", enum: ACTIONS, description: "Operation to perform." },
            taskID: {
              type: "string",
              description: "Task id such as sh_0b4b0a68f001VKDJ3jGnLudahX. Required for 'status', 'output', and 'kill'.",
            },
            scope: {
              type: "string",
              enum: ["session", "location"],
              description: "Which tasks 'list' reports. Defaults to 'session'.",
            },
            cursor: {
              type: "integer",
              minimum: 0,
              description:
                "'output' byte offset to start from. Omit it to read the most recent output, which is usually what you want for a running task. Pass 0 to read from the beginning.",
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: MAX_OUTPUT_LIMIT,
              description: `'output' maximum bytes to read. Defaults to ${DEFAULT_OUTPUT_LIMIT}.`,
            },
          },
          required: ["action"],
          additionalProperties: false,
        },
        execute: async (input, tool) => {
          const now = Date.now()
          const directory = await locationOf(tool.sessionID)
          const location = { directory }

          if (input.action === "list") {
            const result = await call(`/api/shell`, undefined, directory)
            const tasks = [...(result?.data ?? [])]
            // The server's registry does not include tasks spawned by the
            // shell tool, so fold in whatever the event stream reported as
            // still alive. Without this, 'list' always comes back empty.
            const known = new Set(tasks.map((task) => task.id))
            for (const info of seen.values()) {
              if (known.has(info.id)) continue
              if (info.cwd !== directory) continue
              if (info.status !== "running" && info.status !== "unknown") continue
              // The created event only carries a pid when the server knows it,
              // so an absent pid is not evidence of death.
              if (Number.isFinite(info.pid) && !isAlive(info.pid)) continue
              tasks.push(info)
            }
            if (tasks.length === 0) {
              return {
                content: `No background tasks are running in ${directory}.`,
              }
            }
            const scope = input.scope === "location" ? "location" : "session"
            const visible = scope === "session" ? await sessionScope(tool.sessionID, tasks) : tasks
            for (const task of visible) remember(task)
            if (visible.length === 0) {
              return {
                content:
                  `No background tasks are running for this session.\n` +
                  `${tasks.length} task(s) are running elsewhere in ${directory}; call again with scope 'location' to see them.`,
              }
            }
            const header = `${visible.length} running task(s) for ${scope === "session" ? "this session" : directory}:`
            return {
              content: [header, ...visible.map((task) => formatTask(task, now))].join("\n"),
              metadata: { count: visible.length, scope },
            }
          }

          const taskID = typeof input.taskID === "string" ? input.taskID.trim() : ""
          if (taskID.length === 0) {
            return { content: `The '${input.action}' action requires taskID.` }
          }
          if (!/^sh_[0-9a-f]{12}/.test(taskID)) {
            return { content: `'${taskID}' does not look like a task id. Ids start with sh_.` }
          }

          if (input.action === "status") {
            const info = await getTask(taskID, directory)
            if (!info) {
              return { content: missingTaskMessage(taskID, directory, seen.get(taskID), findRetainedLog(taskID)) }
            }
            return { content: formatStatus(info, now) }
          }

          if (input.action === "output") {
            const limit = Number.isFinite(input.limit)
              ? Math.min(MAX_OUTPUT_LIMIT, Math.max(1, Math.trunc(input.limit)))
              : DEFAULT_OUTPUT_LIMIT

            // The endpoint reports the file size only alongside a read, so a
            // tiny probe establishes it before choosing the window. Without an
            // explicit cursor, read the most recent bytes: checking progress on
            // a running task is the common case, and its early output is the
            // least interesting part.
            const probe = await call(
              `/api/shell/${encodeURIComponent(taskID)}/output?cursor=${Number.MAX_SAFE_INTEGER}&limit=1`,
              undefined,
              directory,
            ).catch((error) => {
              if (error?.notFound) return undefined
              throw error
            })
            // A task's record disappears when it exits, but its captured output
            // stays on disk, so page through that file instead of giving up.
            const retained = probe ? undefined : findRetainedLog(taskID)
            if (!probe && !retained) {
              return { content: missingTaskMessage(taskID, directory, seen.get(taskID)) }
            }

            let size = typeof probe?.data?.size === "number" ? probe.data.size : 0
            if (!probe) {
              try {
                size = readLogWindow(retained, 0, 0).size
              } catch {
                return { content: missingTaskMessage(taskID, directory, seen.get(taskID)) }
              }
            }
            const explicit = Number.isFinite(input.cursor)
            const cursor = explicit ? Math.max(0, Math.trunc(input.cursor)) : Math.max(0, size - limit)

            if (cursor >= size) {
              const details = seen.get(taskID) ?? (await getTask(taskID, directory))
              const status = details?.status ?? "unknown"
              return {
                content: `Task ${taskID} (${status}) has no output past byte ${cursor} (total ${size} bytes).`,
                metadata: { status, size, cursor },
              }
            }

            let body
            let end
            if (!probe) {
              try {
                const window = readLogWindow(retained, cursor, limit)
                body = window.output
                end = window.next
              } catch {
                return { content: missingTaskMessage(taskID, directory, seen.get(taskID), retained) }
              }
            } else {
              const result = await call(
                `/api/shell/${encodeURIComponent(taskID)}/output?cursor=${cursor}&limit=${limit}`,
                undefined,
                directory,
              ).catch((error) => {
                if (error?.notFound) return undefined
                throw error
              })
              if (!result) {
                return { content: missingTaskMessage(taskID, directory, seen.get(taskID), findRetainedLog(taskID)) }
              }
              const data = result?.data ?? {}
              body = typeof data.output === "string" ? data.output : ""
              end = typeof data.cursor === "number" ? data.cursor : cursor
            }

            // Populate the status cache when the caller jumped straight to
            // 'output' without a prior 'list' or 'status'.
            const details = seen.get(taskID) ?? (await getTask(taskID, directory))
            const status = details?.status ?? "unknown"
            const range = explicit
              ? `bytes ${cursor}..${end} of ${size}`
              : `most recent ${end - cursor} of ${size} bytes`
            const lines = [
              `Task ${taskID} (${status}) output, ${range}:`,
              "",
              body.length > 0 ? body : "(no output yet)",
            ]
            if (!probe) {
              lines.push("", `Paged from the retained log; the server no longer tracks this task:\n  ${retained}`)
            }
            if (status === "running") lines.push("", "The task is still running; this file keeps growing.")
            if (cursor > 0) {
              lines.push(
                `Earlier output exists. Pass cursor=0 to read from the start, or cursor=${end} to continue from here.`,
              )
            }
            return { content: lines.join("\n"), metadata: { status, size, cursor: end } }
          }

          // kill
          // The server's registry does not track shell-tool tasks, so DELETE is
          // accepted and ignored. Signal the process group directly when the
          // record is unknown locally but the task is still alive.
          const before = await getTask(taskID, directory)
          const cached = seen.get(taskID)
          if (!before) {
            const fallback = async () => {
              const candidate = cached
              if (!candidate || candidate.status !== "running") {
                return { content: missingTaskMessage(taskID, directory, candidate, findRetainedLog(taskID)) }
              }
              const pgrp = taskProcessGroup(candidate.command, candidate.time?.started, candidate.pid)
              if (!pgrp) {
                return {
                  content:
                    `Task ${taskID} is not registered with the server and its process could not be ` +
                    `identified unambiguously, so it was not killed.\n` +
                    `  command: ${flatten(candidate.command, 200)}\n` +
                    `Kill it manually if needed.`,
                }
              }
              markKilled(taskID)
              let signalled = true
              try {
                process.kill(-pgrp, "SIGTERM")
              } catch (error) {
                signalled = false
                if (error?.code !== "ESRCH") {
                  return { content: `Failed to terminate ${taskID}: ${error?.message ?? error}` }
                }
              }
              seen.set(taskID, { ...candidate, status: "killed" })
              return {
                content:
                  `Terminated ${taskID} (${flatten(candidate.command, DESCRIPTION_LIMIT)}).\n` +
                  `  signalled: process group ${pgrp}${signalled ? "" : " (already gone)"}\n` +
                  `Completion notice suppressed (best effort).`,
                metadata: { taskID, command: candidate.command, pgrp },
              }
            }
            return await fallback()
          }
          if (before.status !== "running") {
            return {
              content: `Task ${taskID} is not running (status: ${before.status}); nothing to kill.`,
            }
          }
          // Record the kill before it happens: the completion watcher can
          // enqueue its notification before `shell.deleted` reaches us.
          markKilled(taskID)
          await call(`/api/shell/${encodeURIComponent(taskID)}`, { method: "DELETE" }, directory)
          return {
            content: `Terminated ${taskID} (${flatten(before.command, DESCRIPTION_LIMIT)}). Completion notice suppressed (best effort).`,
            metadata: { taskID, command: before.command },
          }
        },
      })

      // Put the auto-wake note where background tasks are actually started, so
      // the model does not busy-wait with sleep loops after launching one.
      const shell = editor.get("shell")
      if (shell && typeof shell.description === "string" && !shell.description.includes(WAKE_NOTE)) {
        editor.update("shell", (tool) => {
          tool.description = `${tool.description}\n\n${WAKE_NOTE}`
        })
      }
    })

    return () => {
      abort.abort()
      clearInterval(pruneTimer)
    }
  },
}

function bearer(password) {
  return `Basic ${Buffer.from(`${AUTH_USER}:${password}`).toString("base64")}`
}
