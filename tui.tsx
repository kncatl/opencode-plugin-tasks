/**
 * Background tasks panel.
 *
 * - Adds a "Tasks" section to the session sidebar, after Context and MCP.
 * - Adds a `/tasks` slash command (and palette entry) that opens a dialog with
 *   running tasks, recent tasks, live output, and kill.
 *
 * Everything is client-side: the terminal client already keeps a live shell
 * registry in `data.shell` and exposes the management API through
 * `client.shell`, so this plugin only renders and forwards intent.
 *
 * Four API facts shape the code below:
 * - Keymap layers must be registered from a rendered component, not from
 *   `setup`, because the keymap provider only exists inside the UI tree.
 * - `data.shell` is location scoped and drops a task as soon as it exits, while
 *   the server keeps the record. Finished tasks are therefore snapshotted
 *   through `client.shell.get` and remembered in plugin storage.
 * - A task that ran in the background reports completion through a synthetic
 *   session message carrying `metadata.source === "shell"`; foreground commands
 *   never produce one. That marker is what distinguishes tasks from ordinary
 *   shell history.
 * - `shell` tool tasks carry their owning session in `metadata.sessionID`, so
 *   session scope is derived here.
 */

import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { closeSync, fstatSync, openSync, readSync } from "node:fs"

const SIDEBAR_LIMIT = 4
const HISTORY_LIMIT = 10
const HISTORY_KEEP = 30
const TAIL_CHARS = 2000
const MAX_TREE_SESSIONS = 12
/**
 * Bytes kept in the output view. The first read takes the tail, so a long log
 * shows its newest output rather than its oldest; later reads append and trim.
 */
const OUTPUT_LIMIT = 65536
const OUTPUT_LINES = 200
/** Poll interval once the output stream has caught up with a running task. */
const OUTPUT_POLL_MS = 1000
const MAX_TREE_DEPTH = 32

/**
 * The dialog host fixes only the panel width; it does not cap the height, so
 * the plugin bounds its own content. The task list and the output box share
 * the rows left after the fixed chrome (header, hints, footer, dialog
 * padding), which keeps the dialog inside the terminal when history has piled
 * up and the output is expanded.
 */
const DIALOG_CHROME_ROWS = 15
const LIST_MIN_ROWS = 3
const LIST_MAX_ROWS = 12
const OUTPUT_MIN_ROWS = 4
const OUTPUT_MAX_ROWS = 24

const GLYPH = {
  running: "●",
  exited: "✓",
  failed: "✕",
  timeout: "⏱",
  killed: "✕",
}

/**
 * A task removed from the shell registry while the shell tool is still waiting
 * for it makes the tool report `Shell.NotFoundError`. That happens when a kill
 * is performed from outside the task (the Tasks dialog, the AI's tasks tool):
 * the registry entry disappears and the tool has nothing left to read.
 *
 * Normally the server plugin cancels the completion notice before it is
 * delivered, so this text never reaches the session. When cancellation loses
 * its race with delivery, this notice is the only trace the kill leaves, and
 * it must not be mistaken for a failure. The server plugin recognises a kill
 * by the same text.
 */
const SHELL_GONE = /Shell\.NotFoundError|Shell command not found/i

/**
 * The generated client tags a missing task record with `_tag`; the server
 * plugin's own HTTP wrapper uses `notFound`. Either one means the record is
 * gone, not that the connection failed.
 */
function isNotFound(error) {
  return error?._tag === "ShellNotFoundError" || error?.notFound === true
}

function isKillNotice(message) {
  return message?.metadata?.state === "error" && SHELL_GONE.test(String(message?.text ?? ""))
}

function flatten(value, max) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return ""
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${seconds % 60 ? ` ${seconds % 60}s` : ""}`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`
}

function statusColor(theme, status) {
  if (status === "running") return theme.text.feedback.info.base
  if (status === "exited") return theme.text.feedback.success.base
  if (status === "timeout") return theme.text.feedback.warning.base
  return theme.text.feedback.error.base
}

function detail(task) {
  const parts = []
  if (task.status === "running" && task.started) parts.push(formatDuration(Date.now() - task.started))
  if (task.completed && task.started) parts.push(`took ${formatDuration(task.completed - task.started)}`)
  if (typeof task.exit === "number" && task.status !== "running") parts.push(`exit ${task.exit}`)
  if (task.status === "running" && task.pid) parts.push(`pid ${task.pid}`)
  return parts.join(" · ")
}

function ownerOf(info) {
  const owner = info.metadata?.sessionID
  return typeof owner === "string" && owner.length > 0 ? owner : undefined
}

function asTask(info) {
  return {
    id: info.id,
    command: info.command,
    status: info.status,
    exit: typeof info.exit === "number" ? info.exit : undefined,
    started: info.time?.started,
    completed: info.time?.completed,
    pid: info.pid,
    file: info.file,
    sessionID: ownerOf(info),
    source: "live",
  }
}

function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    const rank = (task) => (task.status === "running" ? 0 : 1)
    return rank(a) - rank(b) || (b.started ?? 0) - (a.started ?? 0)
  })
}

function taskStatus(state) {
  if (state === "completed") return "exited"
  if (state === "cancelled") return "killed"
  if (state === "timeout") return "timeout"
  if (state === "error") return "failed"
  return typeof state === "string" && state.length > 0 ? state : "killed"
}

/**
 * Sessions to include in session scope: the session itself plus every
 * descendant, so subagent work stays visible from the parent session.
 * `data.session.family` is preferred when already synced; otherwise the tree is
 * walked from the session list.
 */
function sessionTree(context, sessionID) {
  if (!sessionID) return []
  const family = context.data.session.family(sessionID)
  if (family.length > 0) return [sessionID, ...family]

  const sessions = context.data.session.list()
  const byID = new Map(sessions.map((session) => [session.id, session]))
  const included = [sessionID]
  for (const session of sessions) {
    let cursor = session
    for (let depth = 0; depth < MAX_TREE_DEPTH && cursor?.parentID; depth++) {
      if (cursor.parentID === sessionID) {
        included.push(session.id)
        break
      }
      cursor = byID.get(cursor.parentID)
    }
  }
  return included.slice(0, MAX_TREE_SESSIONS)
}

/** Live shell registry for one session's location, refreshed by shell events. */
function useShellTasks(context, sessionID) {
  const location = () => {
    const id = sessionID()
    return (id ? context.data.session.get(id)?.location : undefined) ?? context.data.location.default()
  }

  const refresh = () => {
    void context.data.shell.sync(location()).catch(() => {})
  }

  onMount(refresh)
  onCleanup(context.data.on("shell.created", refresh))
  onCleanup(context.data.on("shell.exited", refresh))
  onCleanup(context.data.on("shell.deleted", refresh))

  const atLocation = () => context.data.shell.list(location()) ?? []
  const mine = () => {
    const included = new Set(sessionTree(context, sessionID()))
    return atLocation().filter((info) => {
      const owner = ownerOf(info)
      return owner !== undefined && included.has(owner)
    })
  }
  const unowned = () => atLocation().filter((info) => ownerOf(info) === undefined).length

  return { location, refresh, atLocation, mine, unowned }
}

/**
 * Durable list of tasks that actually ran in the background. The marker is the
 * completion notification the shell tool injects as a synthetic session
 * message; ordinary foreground commands never produce one.
 */
function useTaskHistory(context, sessions, location) {
  const [history, updateHistory] = context.storage.store("history", { initial: { items: [] } })
  const scanned = new Set()
  const synced = new Set()

  // Earlier builds recorded every shell command. New records carry a version
  // marker so one-time cleanup drops the noise without touching real tasks.
  onMount(() => {
    void updateHistory((draft) => {
      draft.items = (draft.items ?? []).filter((item) => item.v === 2)
    }).catch(() => {})
  })

  const record = (entry) => {
    void updateHistory((draft) => {
      draft.items = draft.items ?? []
      const index = draft.items.findIndex((item) => item.id === entry.id)
      if (index >= 0) {
        const merged = { ...draft.items[index], ...entry, v: 2 }
        // A cancellation is authoritative over the error notice a killed task
        // emits when its record disappears. That notice is visible in the
        // message cache first, so without this a kill can be recorded as
        // "failed" and never corrected.
        if (draft.items[index].status === "killed" && entry.status !== "killed") {
          merged.status = "killed"
        }
        draft.items[index] = merged
      } else {
        draft.items.push({ ...entry, v: 2 })
      }
      if (draft.items.length > HISTORY_KEEP) draft.items = draft.items.slice(-HISTORY_KEEP)
    }).catch(() => {})
  }

  const snapshot = async (id, message) => {
    const directory = location().directory
    try {
      const result = await context.client.shell.get({ id, location: location() })
      const info = result.data
      record({
        id,
        command: info.command,
        directory,
        sessionID: ownerOf(info),
        file: info.file,
        started: info.time?.started,
        completed: info.time?.completed ?? Date.now(),
        exit: typeof info.exit === "number" ? info.exit : undefined,
        status: info.status,
      })
    } catch {
      // The record was already pruned; fall back to the notification itself.
      const text = typeof message.text === "string" ? message.text : ""
      record({
        id,
        command: message.description ?? id,
        directory,
        started: undefined,
        completed: message.time?.created ?? Date.now(),
        exit: typeof message.metadata?.exit === "number" ? message.metadata.exit : undefined,
        status: isKillNotice(message) ? "killed" : taskStatus(message.metadata?.state),
        tail: text.length > TAIL_CHARS ? text.slice(-TAIL_CHARS) : text,
      })
    }
  }

  const scan = () => {
    for (const sessionID of sessions()) {
      const messages = context.data.session.message.list(sessionID)
      if (!messages || messages.length === 0) {
        if (!synced.has(sessionID)) {
          synced.add(sessionID)
          void context.data.session.message.sync(sessionID).catch(() => {})
        }
        continue
      }
      for (const message of messages) {
        const meta = message?.metadata
        if (message?.type !== "synthetic" || meta?.source !== "shell") continue
        const id = meta.shellID
        if (typeof id !== "string" || id.length === 0 || scanned.has(id)) continue
        scanned.add(id)
        if ((history.items ?? []).some((item) => item.id === id)) continue
        void snapshot(id, message)
      }
    }
  }

  createEffect(() => scan())

  // Terminations never reach the session: the server plugin cancels the
  // completion notice so no turn is resumed. The notice is still published on
  // the event stream first, and its cancellation is what marks a deliberate
  // kill, so the pair is what gets recorded here.
  const notified = new Map()

  onCleanup(
    context.data.on("session.inbox.enqueued", (event) => {
      const item = event.data?.item
      const meta = item?.payload?.metadata
      if (item?.type !== "synthetic" || meta?.source !== "shell") return
      if (typeof meta.shellID !== "string") return
      notified.set(event.data.inboxID, {
        shellID: meta.shellID,
        command: typeof item.payload?.description === "string" ? item.payload.description : undefined,
        sessionID: event.data.sessionID,
      })
      if (notified.size > 50) notified.delete(notified.keys().next().value)
    }),
  )

  onCleanup(
    context.data.on("session.inbox.cancelled", (event) => {
      const entry = notified.get(event.data.inboxID)
      if (!entry) return
      notified.delete(event.data.inboxID)
      const directory =
        context.data.session.get(entry.sessionID)?.location?.directory ?? location().directory
      // Record unconditionally: scan() may already have snapshotted the
      // pending error notice as "failed" — that notice reaches the message
      // cache before this cancellation — so the provisional status has to be
      // upgraded. record() itself refuses to downgrade an existing kill.
      record({
        id: entry.shellID,
        command: entry.command,
        directory,
        sessionID: entry.sessionID,
        completed: Date.now(),
        status: "killed",
      })
    }),
  )

  const at = (directory) =>
    (history.items ?? [])
      .filter((item) => item.directory === directory)
      .map((item) => ({ ...item, source: "history" }))

  return { at, record }
}

/** Merge live registry over history so a live task never shows twice. */
function combine(live, history) {
  const liveIds = new Set(live.map((task) => task.id))
  const seen = new Set()
  const finished = history
    .filter((task) => !liveIds.has(task.id))
    .filter((task) => {
      if (seen.has(task.id)) return false
      seen.add(task.id)
      return true
    })
    .sort((a, b) => (b.completed ?? b.started ?? 0) - (a.completed ?? a.started ?? 0))
    .slice(0, HISTORY_LIMIT)
  return [...live.map(asTask), ...finished]
}

/**
 * Read a task's retained log. The shell service keeps the captured output at
 * `info.file` after the server drops the task record, so the view can still
 * show it: with a byte cursor it appends what was written after the last
 * served read, otherwise it shows the last OUTPUT_LIMIT bytes. Returns
 * undefined when the file cannot be read at all.
 */
function readRetainedOutput(file, cursor) {
  if (typeof file !== "string" || file.length === 0) return undefined
  try {
    const handle = openSync(file, "r")
    try {
      const size = fstatSync(handle).size
      const start =
        typeof cursor === "number" && cursor >= 0
          ? Math.min(cursor, size)
          : Math.max(0, size - OUTPUT_LIMIT)
      // Never read more than one window, even if the gap since the last served
      // read grew large: the view only keeps the tail anyway.
      const from = Math.max(start, size - OUTPUT_LIMIT)
      const length = size - from
      if (length <= 0) return { text: "", size }
      const buffer = Buffer.allocUnsafe(length)
      const read = readSync(handle, buffer, 0, length, from)
      return { text: buffer.subarray(0, read).toString("utf8"), size }
    } finally {
      closeSync(handle)
    }
  } catch {
    return undefined
  }
}

function TasksSidebar(props) {
  const context = usePlugin()
  const store = useShellTasks(context, () => props.sessionID)
  const tasks = () => sortTasks(store.mine().map(asTask))
  const running = () => tasks().filter((task) => task.status === "running").length

  return (
    <Show when={tasks().length > 0}>
      <box flexDirection="column" id="tasks.sidebar">
        <box flexDirection="row" gap={1}>
          <text fg={context.theme.text.base}>Tasks</text>
          <text fg={context.theme.text.muted}>
            {running() > 0
              ? `${running()} running · ${tasks().length} total`
              : `${tasks().length} total`}
          </text>
        </box>
        <For each={tasks().slice(0, SIDEBAR_LIMIT)}>
          {(task) => (
            <box
              flexDirection="row"
              gap={1}
              onMouseUp={() => context.keymap.dispatch("tasks.list")}
            >
              <text fg={statusColor(context.theme, task.status)}>{GLYPH[task.status] ?? "?"}</text>
              <text fg={context.theme.text.muted}>{flatten(task.command, 24)}</text>
            </box>
          )}
        </For>
        <Show when={tasks().length > SIDEBAR_LIMIT}>
          <text fg={context.theme.text.muted}>
            {`+${tasks().length - SIDEBAR_LIMIT} more · /tasks`}
          </text>
        </Show>
      </box>
    </Show>
  )
}

function TasksDialog(props) {
  const context = usePlugin()
  const state = props.controller
  const dimensions = useTerminalDimensions()

  // Rows the list and the output box may use together, once the fixed chrome
  // of the dialog is accounted for.
  const budget = () => Math.max(6, dimensions().height - DIALOG_CHROME_ROWS)
  const listHeight = () =>
    state.outputOpen()
      ? Math.min(LIST_MAX_ROWS, Math.max(LIST_MIN_ROWS, Math.floor(budget() * 0.4)))
      : Math.min(LIST_MAX_ROWS, budget())
  const outputHeight = () =>
    Math.max(OUTPUT_MIN_ROWS, Math.min(OUTPUT_MAX_ROWS, budget() - listHeight()))

  let listRef
  let outputRef

  // Keep the selected row inside the list viewport while the cursor moves or
  // the list shrinks because the output box was expanded.
  createEffect(() => {
    const task = state.selected()
    state.outputOpen()
    if (!task || !listRef) return
    listRef.scrollChildIntoView(`tasks-row-${task.id}`)
  })

  onMount(() => context.ui.dialog.set({ size: "large", centered: true }))

  // Match the built-in scrollbars: the thumb uses the theme's scrollbar token.
  const scrollbarOptions = () => ({
    trackOptions: {
      backgroundColor: context.theme.background.base,
      foregroundColor: context.theme.scrollbar.base,
    },
  })

  // Registered from the dialog component so the layer exists exactly while this
  // dialog is mounted. A layer registered outside would survive another dialog
  // replacing ours and hijack its keys.
  context.keymap.layer(() => ({
    mode: "modal",
    priority: 10,
    commands: [
      { id: "tasks.prev", title: "Previous task", group: "Tasks", bind: "up,k", run: () => state.move(-1) },
      { id: "tasks.next", title: "Next task", group: "Tasks", bind: "down,j", run: () => state.move(1) },
      {
        id: "tasks.output",
        title: "Toggle output",
        group: "Tasks",
        bind: "return,o",
        run: state.toggleOutput,
      },
      { id: "tasks.kill", title: "Kill task", group: "Tasks", bind: "x", run: state.requestKill },
      {
        id: "tasks.kill.confirm",
        title: "Confirm kill",
        group: "Tasks",
        bind: "y",
        enabled: () => state.confirming(),
        run: () => void state.confirmKill(),
      },
      {
        id: "tasks.kill.cancel",
        title: "Cancel kill",
        group: "Tasks",
        bind: "n",
        enabled: () => state.confirming(),
        run: state.cancelKill,
      },
      { id: "tasks.scope", title: "Toggle task scope", group: "Tasks", bind: "a", run: state.toggleScope },
      { id: "tasks.refresh", title: "Refresh tasks", group: "Tasks", bind: "r", run: state.refresh },
      {
        id: "tasks.output.pageup",
        title: "Scroll output up",
        group: "Tasks",
        bind: "pageup",
        enabled: () => state.outputOpen(),
        run: () => outputRef?.scrollBy(-1, "viewport"),
      },
      {
        id: "tasks.output.pagedown",
        title: "Scroll output down",
        group: "Tasks",
        bind: "pagedown",
        enabled: () => state.outputOpen(),
        run: () => outputRef?.scrollBy(1, "viewport"),
      },
      {
        id: "tasks.output.start",
        title: "Output start",
        group: "Tasks",
        bind: "home",
        enabled: () => state.outputOpen(),
        run: () => outputRef?.scrollTo(0),
      },
      {
        id: "tasks.output.end",
        title: "Output end",
        group: "Tasks",
        bind: "end",
        enabled: () => state.outputOpen(),
        run: () => outputRef?.scrollTo(Number.POSITIVE_INFINITY),
      },
    ],
  }))

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} gap={1}>
      <box flexDirection="row" gap={1}>
        <text fg={context.theme.text.base}>Background tasks</text>
        <text fg={context.theme.text.muted}>
          {`${state.tasks().length} ${state.showAll() ? "at this location" : "in this session"}`}
        </text>
      </box>

      <Show
        when={state.tasks().length > 0}
        fallback={
          <text fg={context.theme.text.muted}>
            No background tasks yet. Use the shell tool with background: true, or press ctrl+b on a
            running command.
          </text>
        }
      >
        <scrollbox
          maxHeight={listHeight()}
          contentOptions={{ minHeight: 0 }}
          verticalScrollbarOptions={scrollbarOptions()}
          ref={(value) => (listRef = value)}
        >
          <For each={state.tasks()}>
            {(task, index) => {
              const active = () => index() === Math.min(state.cursor(), state.tasks().length - 1)
              return (
                <box
                  flexDirection="row"
                  gap={1}
                  id={`tasks-row-${task.id}`}
                  onMouseUp={() => state.setCursor(index())}
                >
                  <text fg={active() ? context.theme.text.base : context.theme.text.muted}>
                    {active() ? "❯" : " "}
                  </text>
                  <text fg={statusColor(context.theme, task.status)}>{GLYPH[task.status] ?? "?"}</text>
                  <text fg={active() ? context.theme.text.base : context.theme.text.muted}>
                    {task.id}
                  </text>
                  <text fg={context.theme.text.muted}>{flatten(task.command, 44)}</text>
                  <text fg={context.theme.text.muted}>{detail(task)}</text>
                </box>
              )
            }}
          </For>
        </scrollbox>
      </Show>

      <Show when={!state.showAll() && state.unowned() > 0}>
        <text fg={context.theme.text.muted}>
          {`${state.unowned()} running task(s) at this location are not tied to a session · press a`}
        </text>
      </Show>

      <Show when={state.outputOpen()}>
        <box flexDirection="column">
          <text fg={context.theme.text.muted}>{state.outputLabel()}</text>
          <scrollbox
            height={outputHeight()}
            contentOptions={{ minHeight: 0 }}
            verticalScrollbarOptions={scrollbarOptions()}
            stickyScroll
            stickyStart="bottom"
            ref={(value) => (outputRef = value)}
          >
            <text fg={context.theme.text.base} wrapMode="word">
              {state.outputTail()}
            </text>
          </scrollbox>
        </box>
      </Show>

      <Show when={state.confirming()}>
        <text fg={context.theme.text.feedback.warning.base}>
          {`Kill ${state.selected()?.id ?? "task"}? y to confirm · n to cancel`}
        </text>
      </Show>

      <Show when={state.notice()}>
        <text fg={context.theme.text.muted}>{state.notice()}</text>
      </Show>

      <text fg={context.theme.text.muted}>
        {state.outputOpen()
          ? "↑↓ select · pgup/pgdn scroll output · enter close · x kill · a scope · r refresh · esc close"
          : "↑↓ select · enter output · x kill · a scope · r refresh · esc close"}
      </text>
    </box>
  )
}

/**
 * Always-mounted contribution that owns the `/tasks` command and the dialog
 * state. Rendered through the `app` slot so its global keymap layer and event
 * subscriptions live for the plugin's whole lifetime.
 */
function TasksApp(props) {
  const context = props.context
  const [open, setOpen] = createSignal(false)
  const [sessionID, setSessionID] = createSignal(undefined)
  const [cursor, setCursor] = createSignal(0)
  const [showAll, setShowAll] = createSignal(false)
  const [outputOpen, setOutputOpen] = createSignal(false)
  const [output, setOutput] = createSignal(undefined)
  const [outputLabel, setOutputLabel] = createSignal("output")
  const [confirming, setConfirming] = createSignal(false)
  const [notice, setNotice] = createSignal(undefined)

  const store = useShellTasks(context, sessionID)
  const sessions = () => sessionTree(context, sessionID())
  const history = useTaskHistory(context, sessions, store.location)

  // Track the active session so history is scanned in the background and ready
  // before the dialog is opened.
  createEffect(() => {
    const route = context.ui.router.current()
    if (route.type === "session") setSessionID(route.sessionID)
  })

  const tasks = createMemo(() => {
    const directory = store.location().directory
    if (showAll()) return combine(store.atLocation(), history.at(directory))
    const included = new Set(sessions())
    const own = history
      .at(directory)
      .filter((item) => item.sessionID === undefined || included.has(item.sessionID))
    return combine(store.mine(), own)
  })

  const selected = createMemo(() => {
    const list = tasks()
    if (list.length === 0) return undefined
    return list[Math.min(cursor(), list.length - 1)]
  })

  const move = (delta) =>
    setCursor((current) => {
      const max = Math.max(0, tasks().length - 1)
      return Math.min(max, Math.max(0, current + delta))
    })

  // --- output stream -------------------------------------------------------
  //
  // The view follows the selected task instead of loading a one-shot snapshot.
  // New output has no event of its own (shell events only announce creation
  // and exit), so the stream polls: read from the current byte cursor,
  // continue immediately while a backlog remains, and wait a second once
  // caught up — the same shape the built-in shell viewer uses.
  //
  // When the task exits the server drops its record and the endpoint starts
  // answering 404. The captured log stays on disk, so the stream switches to
  // that file and stops polling; the same file serves tasks whose record was
  // gone long before the view was opened.

  let stream

  const stopStream = () => {
    if (stream?.timer !== undefined) clearTimeout(stream.timer)
    stream = undefined
  }

  const appendChunk = (chunk) => {
    if (chunk.length === 0) return
    const merged = stream.buffer + chunk
    if (merged.length > OUTPUT_LIMIT) stream.trimmed = true
    stream.buffer = merged.slice(-OUTPUT_LIMIT)
    setOutput(stream.buffer)
  }

  const refreshOutputLabel = (retained) => {
    const window = stream.trimmed ? ` · last ${Math.round(OUTPUT_LIMIT / 1024)} KB` : ""
    setOutputLabel(`output · ${stream.size} bytes${window}${retained ? " · retained log" : ""}`)
  }

  const finishStream = () => {
    if (stream.timer !== undefined) {
      clearTimeout(stream.timer)
      stream.timer = undefined
    }
    const retained = readRetainedOutput(stream.file, stream.cursor >= 0 ? stream.cursor : undefined)
    if (retained) {
      appendChunk(retained.text)
      stream.size = Math.max(stream.size, retained.size)
      refreshOutputLabel(true)
      return
    }
    if (stream.buffer.length > 0) {
      refreshOutputLabel(false)
      return
    }
    // Nothing on disk either: the notice tail is all that is left.
    if (stream.tail) {
      setOutput(stream.tail)
      setOutputLabel("output · from completion notice (tail)")
      return
    }
    setOutput("Output is no longer available for this task.")
    setOutputLabel("output")
  }

  const streamStep = async (id, location) => {
    const current = stream
    if (!current || current.id !== id) return
    try {
      if (current.cursor < 0) {
        // Learn the size first, then start from the tail window.
        const probe = await context.client.shell.output({
          id,
          location,
          cursor: Number.MAX_SAFE_INTEGER,
          limit: 1,
        })
        if (stream !== current) return
        current.size = typeof probe.data?.size === "number" ? probe.data.size : 0
        current.cursor = Math.max(0, current.size - OUTPUT_LIMIT)
      }
      const before = current.cursor
      const result = await context.client.shell.output({
        id,
        location,
        cursor: current.cursor,
        limit: OUTPUT_LIMIT,
      })
      if (stream !== current) return
      const data = result.data ?? {}
      if (typeof data.size === "number") current.size = data.size
      if (typeof data.cursor === "number") current.cursor = data.cursor
      appendChunk(typeof data.output === "string" ? data.output : "")
      refreshOutputLabel(false)

      const caughtUp = current.cursor >= current.size
      const live = context.data.shell.get(id)
      if (caughtUp && live !== undefined && live.status !== "running") {
        finishStream()
        return
      }
      current.timer = setTimeout(
        () => void streamStep(id, location),
        caughtUp || current.cursor <= before ? OUTPUT_POLL_MS : 0,
      )
    } catch (error) {
      if (stream !== current) return
      if (isNotFound(error)) {
        finishStream()
        return
      }
      // Transient failure: keep what is displayed and retry.
      setOutputLabel("output · unable to read; retrying…")
      current.timer = setTimeout(() => void streamStep(id, location), OUTPUT_POLL_MS)
    }
  }

  const startStream = (task, location) => {
    if (stream?.id === task.id) return
    stopStream()
    stream = {
      id: task.id,
      cursor: -1,
      size: 0,
      buffer: "",
      trimmed: false,
      timer: undefined,
      file: task.file,
      tail: task.tail,
    }
    setOutput(undefined)
    setOutputLabel("output · loading…")
    void streamStep(task.id, location)
  }

  const toggleOutput = () => {
    if (outputOpen()) {
      setOutputOpen(false)
      setOutput(undefined)
      return
    }
    setOutputOpen(true)
  }

  const requestKill = () => {
    const task = selected()
    if (!task) return
    if (task.status !== "running") {
      setNotice("Only running tasks can be killed")
      return
    }
    setNotice(undefined)
    setConfirming(true)
  }

  const cancelKill = () => setConfirming(false)

  const confirmKill = async () => {
    const task = selected()
    setConfirming(false)
    if (!task) return
    try {
      const snapshot = await context.client
        .shell.get({ id: task.id, location: store.location() })
        .then((result) => result.data)
        .catch(() => undefined)
      await context.client.shell.remove({ id: task.id, location: store.location() })
      history.record({
        id: task.id,
        command: snapshot?.command ?? task.command,
        directory: store.location().directory,
        sessionID: ownerOf(snapshot ?? { metadata: { sessionID: task.sessionID } }),
        file: snapshot?.file,
        started: snapshot?.time?.started ?? task.started,
        completed: Date.now(),
        exit: undefined,
        status: "killed",
      })
      setNotice(`Killed ${task.id}`)
      setOutputOpen(false)
      setOutput(undefined)
      store.refresh()
    } catch (error) {
      setNotice(`Kill failed: ${String(error)}`)
    }
  }

  const toggleScope = () => setShowAll((value) => !value)

  const refresh = () => {
    store.refresh()
    if (outputOpen()) {
      const task = selected()
      if (task) {
        // Restart the stream so a manual refresh re-reads the tail window.
        stopStream()
        startStream(task, store.location())
      }
    }
  }

  // One live stream for the selected task while the output view is open. The
  // stream restarts when the selection changes and stops when the view closes;
  // new output does not re-run this effect because the stream polls on its own.
  createEffect(() => {
    const task = open() && outputOpen() ? selected() : undefined
    const location = store.location()
    if (!task) {
      stopStream()
      return
    }
    startStream(task, location)
  })

  onCleanup(stopStream)

  const outputTail = createMemo(() => {
    const raw = output()
    if (raw === undefined) return ""
    const lines = raw.replace(/\r\n?/g, "\n").split("\n")
    return (lines.length > OUTPUT_LINES ? lines.slice(-OUTPUT_LINES) : lines).join("\n")
  })

  const controller = {
    tasks,
    selected,
    cursor,
    setCursor,
    showAll,
    outputOpen,
    outputLabel,
    outputTail,
    confirming,
    notice,
    unowned: () => store.unowned(),
    move,
    toggleOutput,
    requestKill,
    confirmKill,
    cancelKill,
    toggleScope,
    refresh,
  }

  const openDialog = () => {
    if (open()) return
    const route = context.ui.router.current()
    if (route.type !== "session") {
      context.ui.toast.show({
        message: "Open a session to manage its background tasks",
        variant: "warning",
      })
      return
    }
    setSessionID(route.sessionID)
    setCursor(0)
    setShowAll(false)
    setOutputOpen(false)
    setOutput(undefined)
    setConfirming(false)
    setNotice(undefined)
    setOpen(true)
    context.ui.dialog.show(
      () => <TasksDialog controller={controller} />,
      () => setOpen(false),
    )
  }

  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "tasks.list",
        title: "Background tasks",
        description: "Review, inspect output, and kill background shell tasks",
        group: "Tools",
        slash: { name: "tasks" },
        palette: true,
        run: openDialog,
      },
    ],
  }))

  return null
}

export default Plugin.define({
  id: "tasks",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: (input) => <TasksSidebar sessionID={input.sessionID} />,
    })

    context.ui.slot({
      append: "app",
      render: () => <TasksApp context={context} />,
    })
  },
})
