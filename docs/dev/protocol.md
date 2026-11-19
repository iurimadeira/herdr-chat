# herdr-chat wire protocol (v1)

The contract between **herdr-chat-host** (Node, owns `pi --mode rpc`) and its
clients (the Herdr mod `chat` (folder `herdr-app/mods/chat`), the `herdr-chat-host inspect` CLI, tests).
Both sides change only together. Bump `v` on breaking changes.

## Transport

The host listens on `127.0.0.1`, on two OS-assigned ports that carry the same
records:

- **`port`: JSONL over TCP**, for Node clients (`inspect`, the tests, another
  host taking a session over). One JSON object per record, UTF-8, terminated by
  `\n`. Split on `\n` only. Never treat U+2028/U+2029 as separators.
- **`wsPort`: WebSocket**, for the mod. A handshake with an `Origin` header (a
  web page) is refused before the token.
  - Host → mod: a text message carries one or more records, separated by
    `\n` (as in JSONL, with no trailing `\n`). A message is at most 8 MiB.
  - Mod → host: one record per text message, plus `{"t":"ack"}`, which the mod
    sends for each message as soon as it reads it, before applying it. An ACK
    is transport only: it isn't a request and gets no reply.
  - The host keeps at most 4 messages unacknowledged per client. Records it
    can't send yet wait in order; when an ACK frees a slot, everything waiting
    goes out in one message (split at 8 MiB). Herdr's runtime closes a
    WebSocket when 8 messages wait unread, which happens whenever any mod keeps
    the app's JS thread busy while the agent streams. A link that missed an ACK
    never gets that slot back, so the mod reconnects when an ACK fails to send.

The mod uses the WebSocket because of how Herdr frees a mod's sockets. A mod
reload (an install) leaves the old build's objects to QuickJS's cycle collector,
which can take hours. A socket of Herdr's `net` module (3 descriptors) is freed
only with its object; after about 80 the app can't open a file or connect.
A WebSocket is freed as soon as it's closed, so each new build of the mod closes
the links older builds left open (`transport.js`), and a closed chat closes its
own. A host from before 0.4 has no `wsPort`, and the mod reaches it over TCP.

On either transport:

- The first client record must be `hello` within 5 s, else the host closes the
  connection. A wrong token closes it without a reply. Compare tokens in
  constant time.
- Several clients may be connected at once. They all get the same records.
- A client whose unsent records pass 64 MiB (it stopped reading, or stopped
  ACKing) is cut off.

## Chat registry (discovery)

The host writes `<stateDir>/chats/<chat>.json` with mode 0600:

```json
{ "v": 1, "chat": "c-1a2b3c4d", "pid": 4242, "port": 51234, "wsPort": 51235, "token": "<64 hex>",
  "cwd": "/abs/dir", "sessionFile": "/abs/x.jsonl" | null, "terminal": "t7" | null,
  "startedAt": 1793700000000, "agentVersion": "1.5.0" | null, "socket": "/abs/<chat>.<pid>.sock" | null }
```

`socket` is the host's Unix socket (v3.8, "remote chats"); absent in entries written before v3.8.

- `stateDir` is passed on the host command line (`--state-dir`). The mod uses
  `appHome() + "/data/herdr-chat"`.
- **Atomic write:** write a temp file, then rename it over the old one.
- `terminal` is `$HC_TERMINAL_ID` of the host's terminal.
- On clean exit the host rewrites the file with `pid: null, port: null, wsPort: null` and
  keeps `sessionFile`, so a client can restart the chat on the same session.
- A client treats the host as alive only after a successful `hello`/`welcome`.
  A `pid` alone doesn't prove it.

## Records: client → host

```jsonc
{"t":"hello","v":1,"token":"…","client":"mod"|"cli"|"test"}
{"t":"req","id":"r1","op":"<op>", ...args}          // see Ops
{"t":"ack"}                                        // WebSocket only: one per message read (see Transport)
```

## Records: host → client

```jsonc
{"t":"welcome","v":1,"chat":"c-…","host":{"pid":1,"version":"0.3.0","build":"9b33f09757a7","startedAt":1793700000000}}   // build, startedAt: v3.5
{"t":"snapshot","seq":12,"state":ChatState,"items":Item[],"hasOlder":false}
{"t":"patch","seq":13,"state":{…partial ChatState},"upsert":[Item…],"remove":["id"]}
{"t":"res","id":"r1","ok":true,"data":…}            // or {"ok":false,"error":"text"}
{"t":"toast","level":"info"|"warning"|"error","text":"…"}
{"t":"bye","reason":"…"}
{"t":"ping"}                                      // TCP only, every 15 s; clients ignore it (keeps a mod's idle TCP socket readable)
```

- `snapshot` is sent right after `welcome`, and again whenever the host
  replaces its whole timeline (new session, switch session). `items` holds the
  newest `MAX_SNAPSHOT_ITEMS` (200) items, oldest first. `hasOlder` says
  whether more exist; fetch them with `history`.
- `seq` grows by 1 for every snapshot and patch.
- A `patch` applies to the client's copy in this order:
  1. Shallow-merge `state` into the client's `ChatState`. A key set to `null`
     clears it.
  2. Upsert each item by `id`: replace it whole if known, else append. New
     items always come after existing ones in timeline order.
  3. Drop the `remove` ids.
- **Ordering:** before every `res`, the host flushes pending state and items, so
  an op's effects (e.g. `phase: "handoff"`) arrive before its `res`.
- **Coalescing:** the host flushes changed items and state at most every
  50 ms. Changes to `phase`, `dialog`, `queue` and errors flush immediately.
  An item is always sent whole (bounded, see Limits), never as a diff.

## ChatState

```ts
type ChatState = {
  phase: "starting" | "idle" | "working" | "compacting" | "handoff" | "exited" | "error";
  error: string | null;          // last fatal or startup error, plain text
  cwd: string;
  sessionFile: string | null;
  sessionName: string | null;
  agentVersion: string | null;
  model: { provider: string; id: string; name: string; reasoning: boolean; contextWindow: number | null;
           input: string[] } | null;
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null;
  plan: { explanation?: string;  // the agent's current plan, shown above the composer (v3.6); null: none
          steps: { text: string; status: "pending" | "in_progress" | "completed" }[] } | null;
  usage: { contextTokens: number | null; contextWindow: number | null; percent: number | null;
           cost: number | null } | null;
  queue: { steering: string[]; followUp: string[] };
  dialog: Dialog | null;         // the oldest open extension dialog; answer it to see the next
  dialogsPending: number;        // open dialogs, including `dialog`
  statuses: { key: string; spans: Span[] }[];             // extension setStatus, key order
  widgets: { key: string; placement: "aboveEditor" | "belowEditor"; lines: Span[][] }[];
  title: string | null;          // extension setTitle (ANSI stripped)
  editorText: string | null;     // extension set_editor_text; client puts it in the composer, then calls ack_editor_text
  commands: Command[];           // the slash menu, built-ins first
};

type Span = { text: string; fg?: string; bg?: string; bold?: true; dim?: true; italic?: true; underline?: true };
// fg/bg: "ansi0".."ansi15" (the theme's ANSI colors), "#rrggbb", or (v2) "syn:<token>" for syntax highlighting.
// Tokens: keyword, string, number, literal, function, title, type, class, comment, variable, attr, property,
// meta, tag, punctuation, operator, regexp, symbol, built_in, params, section, bullet, link, emphasis, strong,
// addition, deletion. The client maps them to theme colors (visual-v2.md §3).

type Dialog = {
  id: string;                    // Pi's extension_ui_request id
  method: "select" | "confirm" | "input" | "editor";
  title: string; message?: string; options?: string[]; placeholder?: string; prefill?: string;
  timeoutAt?: number;            // epoch ms, when Pi auto-resolves it
};

type Command = {
  name: string;                  // without "/"
  description: string;
  source: "builtin" | "extension" | "prompt" | "skill";
  handler: "host" | "client";    // client: the mod handles it (pickers, terminal hand-offs)
  args?: string;                 // hint, e.g. "[instructions]"
  argv?: string[];               // a terminal utility's command (/login, /settings)
  input?: string;                // a command that opens the agent's terminal: typed there once it's idle ("/login")
};
```

## Item (timeline)

Each item has `id` (stable for its lifetime), `kind` and `ts` (epoch ms).

```ts
type Item =
  | { id; kind: "user"; ts; text: string; images: number; imagePaths?: string[];
      imageSizes?: ({ w: number; h: number } | null)[];   // v3.7: pixel size of each of imagePaths
      source: "composer" | "external" | "queued" | "extension"; from?: string;
      skill?: { name: string; command: string; path?: string; body?: string } }
  | { id; kind: "assistant"; ts; text: string; streaming: boolean;
      stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted"; error?: string; autonomous?: true;
      blocks?: Block[];           // v2: `text` split for rendering; absent = one markdown block
      model?: string;             // v2: "provider/id" that produced it
      durationMs?: number;        // v2: message_start → message_end
      usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number | null } }
  | { id; kind: "thinking"; ts; text: string; streaming: boolean; durationMs?: number }
  | { id; kind: "tool"; ts; toolCallId: string; name: string;
      title: string;              // one line: "$ ls -la", "Read src/x.ts:10-40", "Edit src/x.ts", "mcp figma · get_file"
      status: "pending" | "running" | "done" | "error";
      args: string;               // pretty JSON, bounded
      output: string;             // text output, bounded (tail kept); ANSI stripped
      outputTruncated: boolean;   // full text via op "tool_output"
      durationMs?: number;
      images?: string[];          // absolute paths of images in the result, saved by the host
      imageSizes?: ({ w: number; h: number } | null)[];   // v3.7: pixel size of each of images
      outputLines?: Span[][];     // v2: `output` as styled lines: bash keeps ANSI colors, read is syntax highlighted
                                  //     by the file's extension (same bounds as `output`)
      detail: ToolDetail }
  | { id; kind: "notice"; ts; level: "info" | "warning" | "error";
      source: "notify" | "retry" | "compaction" | "extension_error" | "host" | "queue" | "plan";
      text: string; spans?: Span[] }
  | { id; kind: "custom"; ts; customType: string; text: string };   // display:true custom messages

// v2: assistant text split into render blocks by the host (fences in the order they appear).
type Block =
  | { type: "markdown"; text: string }
  | { type: "code"; lang: string | null; code: string; open: boolean;   // open: fence not closed yet (streaming)
      lines?: Span[][] }                                                // syntax highlighted, one Span[] per line (≤ 2000 lines)
  | { type: "mermaid"; source: string; open: boolean;
      svg?: string;                 // abs path of the rendered SVG (closed blocks only), themed by `set_theme`
      ascii?: Span[][];             // box-drawing fallback (when SVG fails)
      error?: string };

type ToolDetail =
  | { type: "bash"; command: string; exitCode?: number | null }
  | { type: "read"; path: string; offset?: number; limit?: number }
  | { type: "edit"; path: string; diff: string | null;             // unified diff text when known
      added?: number; removed?: number;                             // v2: line counts
      diffLines?: { kind: "hunk" | "add" | "del" | "ctx" | "meta"; old?: number; new?: number; spans: Span[] }[] }  // v2: highlighted
  | { type: "write"; path: string; bytes?: number }
  | { type: "search"; tool: string; query?: string; path?: string } // grep, find, ls
  | { type: "generic"; server?: string; tool: string };             // MCP (mcp__server__tool) and anything else
```

- **Order:** items are in timeline order. For one assistant response, the
  thinking, text and tool items appear in Pi's `contentIndex` order. A tool
  item is created at `toolcall_start`, or at `tool_execution_start` if that
  comes first, and finished at `tool_execution_end`.
- **History:** the same items are rebuilt from history (`get_messages` on
  resume), so live and resumed timelines look the same.
- **Images:**
  - The host saves the images in tool results, and those attached to user messages, as files: `<stateDir>/images/<chat>/<item id>-<n>.<png|jpg|gif|webp>`.
  - It lists them in `images` / `imagePaths` (absolute paths). These are at most 8 per item.
  - `imageSizes` (v3.7) gives each one's pixel size, in the same order.
  - The mod shows them with `image()`, using a path relative to the app home when it can.
  - Base64 never goes over the wire.
- **Attachments** (the composer's images, `host/attachments.ts`):
  - A pasted image (`clipboard_image`) and a copy of a dropped one (`attach_image`) are files of the chat's own: `<stateDir>/attachments/<chat>/`. The app's `image()` and viewer take only files under its home, so this is what lets the composer show an image before it's sent. The chip holds that path, and `send` sends it.
  - They live with the chat, not one host. The chip's ✕ removes one (`detach_image`). Sending keeps it: a queued message taken back (`queue_edit`) and an agent without image input (`[Image available at: …]`) read it later.
  - `detach_image` keeps a file a held follow-up or a queued steer lists. The bundled composer never holds such a path (`send` clears it, `queue_edit` takes the message out of its lane first), so this guards other clients, and only as far as the host remembers queued messages (`unconfirmed` forgets its oldest past 100).
  - The folder goes only when the chat closes, which is when its pane is gone. The host's pane watch removes it before the host exits. Every other end of a host keeps it, because the chat's composer may still hold its files: `shutdown` (a restart, a take-over), a signal (a restart that falls back to a kill), a crash.
  - A chat whose pane closed while its host was down (crashed, killed, between a restart's two hosts) has no host left to see it go. Every open chat's view asks its host to sweep (`sweep_attachments`, with the mod's orphan sweep, every 30 s): a folder whose chat has no pane in the layout and no live host (its registry pid) goes once two sweeps in a row agree. So the attachments on disk are bounded by the open chats' composers and sent messages, plus at most a minute for a closed one.
  - Not bounded within an open chat: every image sent stays, as the original bytes (up to 64 MiB each), until the chat closes. Downscaling the copies is a later change.
- **Skills:** a message that runs a skill carries `skill`, and `text` is only
  what the person wrote after it. The mod draws the skill as a pill (a click
  shows `body`, what the agent got). `command` is what the person types to run
  it again, without the slash: Pi `skill:<name>`, Claude Code and Codex
  `<name>`. The host takes it from Pi's expanded `<skill …>` block, Codex's
  `skill` input item, or a leading `/<command>` that names one of the chat's
  `skill` commands (`host/skill.ts`). The transcript prints `/<command> text`.
- **Autonomous runs:** an assistant response whose run the user didn't start
  gets `autonomous: true`, preceded by a notice (`source: "host"`) naming the
  cause when known. Examples: an extension wake, a queued follow-up, a
  subagent report.

## Ops (`{"t":"req","id","op",...}`)

| op | args | data | notes |
|---|---|---|---|
| `send` | `text`, `images?: string[]` (abs paths), `mode?: "auto"\|"steer"\|"followUp"` | `{disposition: "started"\|"queued"\|"handled"\|"pending"}` | `auto`: steer while working, else prompt. `followUp` while working: held by the host until the run settles (v3.2). A leading `/name` that is a host built-in runs that built-in. Pi's prompt reply can come late or never (an extension command waiting on a dialog or `custom()`), so the host answers with Pi's `disposition` if it arrives within 1.5 s, else `pending`. Later failures arrive as a toast + notice |
| `abort` | | `{restored: string[]}` | `clear_queue` then `abort`. `restored` is the queued text, for the composer: the steers, then the follow-ups |
| `dialog_answer` | `dialog`, one of `value` / `confirmed` / `cancelled: true` | `{}` | |
| `ack_editor_text` | | `{}` | clears `state.editorText` |
| `models` | | `{models: {provider,id,name,reasoning,enabled}[]}` | `enabled` = in the user's `enabledModels` |
| `set_model` | `provider`, `modelId` (or `model: "provider/id"`) | `{}` | not `id`: that is the request's own id |
| `set_thinking` | `level` | `{}` | |
| `compact` | `instructions?` | `{}` | |
| `new_session` | | `{}` | then a new snapshot |
| `set_name` | `name` | `{}` | |
| `sessions` | `scope?` (`cwd` \| `all`), `query?`, `refresh?` | `{sessions: {path,name,firstMessage,modified,messageCount,cwd,here}[], loading}` | every session of this cwd (or of every folder), newest first; `query`: words that must all be in the name or first message, or (`all`) the folder; name/first message matches first. `messageCount` null when the agent doesn't count (Codex); `here`: ran in this chat's folder (else the client opens a chat in `cwd`). The host reads session files in the background and remembers them until they change: `refresh` reads again (the picker opening); `loading: {done, total}` while reading (`total` 0: not known yet, Codex's pages), null once done, so the client asks again |
| `switch_session` | `path` | `{}` | then a new snapshot |
| `fork_points` | | `{points: {id, text}[]}` | the person's messages in this session, newest first, as typed (a skill as its `/command`). Refused when the agent can't fork (`capabilities.fork`) |
| `fork` | `point` | `{text}` | a new session holding what came before that message (the agent's own fork: Pi `fork`, Claude Code `--fork-session --resume-session-at`, Codex `thread/fork`); the original is unchanged. Then a new snapshot, and `text` (the message, as typed) is the client's to put in its composer |
| `files` | `query`, `limit?` | `{files: string[]}` | cwd-relative paths, fuzzy-ranked. `git ls-files` (else a bounded walk), cached and refreshed every 30 s |
| `clipboard_image` | | `{path: string \| null, size?}` | saves the clipboard image as an attachment, `<stateDir>/attachments/<chat>/<ms>-<hex>-paste.png` (macOS: osascript «class PNGf»); null when the clipboard holds none. `size` (v3.7): its pixel size `{w, h}`, or null |
| `attach_image` | `path` | `{path, size}` | a copy of an image file (a drop) as an attachment, `<ms>-<hex>-<name>` (a name over 200 bytes is shortened, its extension kept). It checks the file as `send` does and fails with the same messages (type, unreadable or over 64 MiB, not a valid PNG/JPEG/GIF/WebP). `size` (v3.7): its pixel size `{w, h}`, or null |
| `detach_image` | `path` | `{}` | the chip's ✕: removes an attachment, unless a held or queued message lists it. Any path outside the chat's attachments is left alone |
| `sweep_attachments` | `open: string[]` | `{removed: string[]}` | `open`: the chats with a pane in the app's layout. Removes the attachments of other chats that have no pane and no live host, once two calls in a row agree (see "Attachments") |
| `history` | `before` (item id), `limit?` | `{items, hasOlder}` | older items |
| `tool_output` | `item` | `{text}` | full output, up to 1 MiB |
| `handoff` | | `{sessionFile}` | stops Pi (aborts first if working), releases the lock, phase → `handoff` |
| `resume` | | `{}` | after a handoff, or to restart Pi: `--session <sessionFile>` (re-reads auth and settings) |
| `shutdown` | | `{}` | stop Pi and the host. The mod's restart and another chat's take-over send it while the chat's pane stays open, so its attachments stay |
| `set_theme` | `colors: {background, foreground, muted, border, accent, ansi0..ansi15}`, `dark: boolean` | `{}` | v2: colors for host-rendered SVGs (mermaid). Re-renders the closed mermaid blocks and sends them as upserts |

## Built-in slash commands (in `state.commands`, `source: "builtin"`)

| name | handler | does |
|---|---|---|
| `model` | client | opens the model picker (`models` / `set_model`) |
| `thinking` | client | opens the thinking picker (`set_thinking`) |
| `compact` | host | `compact` with the rest of the line as instructions |
| `new` (alias `clear`) | host | `new_session` |
| `name` | host | `set_name` |
| `resume` | client | sessions picker (`sessions` / `switch_session`) |
| `reload` | host | `resume` (restart Pi on the same session) |
| `copy` | client | last assistant text to the clipboard |
| `tui` | client | hand off to Pi's TUI in a terminal pane (`handoff`, then `resume` when it exits) |
| `login`, `settings`, `scoped-models` | client | run `pi --no-session` in a terminal pane, then `resume` once it exits |
| `fork` | client | a picker of `fork_points`, then `fork` |
| `tree`, `export`, `hotkeys` | client | like `tui` (they need the session in Pi's TUI) |

Anything else starting with `/` goes to Pi as prompt text: extension
commands, prompt templates and `skill:` commands.

## Host ↔ Herdr (the host's own terminal)

- **Status (stdout):** OSC 7501, same states as Pi's TUI:
  `working` (run or compaction), `blocked` (open dialog; `msg` = its title),
  `done`, `error`, `idle`. Always `app=pi`. Format:
  `ESC ] 7501 ; state=…:app=pi[:msg=<base64>] ESC \`.
- **Input (stdin, raw mode, bracketed paste on with `ESC[?2004h`):** text
  pasted by `hc send` is submitted on `\r` as `send` with
  `source: "external"`. A leading `<hc from="t7 name">…</hc>` sets `from`.
  `ESC` alone or `Ctrl-C` → `abort`.
- **Title (stdout):** OSC 0 with the chat's title. That is the session name, else the extension `setTitle`, else the first user message trimmed to 60 chars, else "Pi". Herdr names notifications after it.
- **Screen:** an append-only plain transcript for `hc read`:
  `> user text`, the final assistant text, one line per tool
  (`· $ ls -la ✓`), notices. No full-screen redraw.

## Limits

| What | Limit |
|---|---|
| tool `output` in an item | tail 16 KiB (`outputTruncated: true`) |
| `args` | 4 KiB |
| tool output kept by the host | 1 MiB |
| assistant/thinking text per item | 256 KiB (head kept, then a truncation marker) |
| snapshot items | 200 |
| record size, both directions | 8 MiB; larger records are dropped and logged |
| code block highlighting | 2000 lines per block, 60k spans per item |
| `diffLines` | 256 KiB of diff |
| mermaid source | 32 KiB |

v2 wire details:
- `diffLines[].spans` exclude the `+`/`-`/space marker; `kind` says which.
- `old`/`new` are omitted when the hunk header has no line positions.
- A code or mermaid block is `open` only while its item is streaming.
- A tool-only assistant message's `usage`/`durationMs` carry over to the next item with text, so a run's assistant items add up to the run.
- Mermaid SVGs are flattened for native renderers (resvg): no `var()`, `color-mix`, `@import` or `foreignObject`; generic font families; a background rect.


## v3: providers (Pi, Claude Code, Codex)

The wire stays the same. Everything below is additive, and Pi chats keep
working unchanged.

### ChatState additions

```ts
provider: "pi" | "claude" | "codex";
providerName: string;                 // "Pi", "Claude Code", "Codex"
capabilities: {
  steer: boolean;                     // a message mid-run is folded into the current run
  followUp: boolean;                  // a message mid-run can wait for the run to end
  thinkingLevels: string[];           // the picker's levels for the current model; [] = no picker
  permissions: boolean;               // the agent asks for approval itself (permission dialogs)
  permissionModes: { id: string; label: string; description?: string }[];  // [] = no mode chip
  extensionUi: boolean;               // statuses/widgets can arrive (Pi extensions)
  compact: boolean; rename: boolean; fork: boolean;
  compactInstructions: boolean;       // /compact takes instructions (Codex: no)
  images: boolean;                    // the current model takes images
  cost: boolean;                      // usage.cost is meaningful (Codex: tokens only)
  tui: boolean;                       // a TUI hand-off exists
};
permissionMode: string | null;        // current id from capabilities.permissionModes
```

`state.commands` (the slash menu) is per provider. The host merges its
built-ins with the agent's commands:
- Pi: `get_commands`;
- Claude: `initialize.commands`, minus the terminal-only ones;
- Codex: skills plus `~/.codex/prompts`.

### Dialog additions

```ts
// method "permission": the agent asks before running a tool.
{ id; method: "permission"; title: string; message?: string;
  tool?: { name: string; title: string; detail?: ToolDetail; args?: string };   // what will run, rendered like a tool card header
  choices: { id: string; label: string; kind: "allow" | "allow_always" | "deny" | "other"; description?: string }[];
  timeoutAt?: number }
// method "questions": the agent asks the user (Claude AskUserQuestion, Codex requestUserInput).
{ id; method: "questions"; title: string;
  questions: { id: string; header?: string; question: string;
               options: { label: string; description?: string; recommended?: boolean }[]; multiSelect: boolean; allowOther: boolean }[] }
```

An option's `recommended` marks the one the agent suggests: the card's highlight starts there. Claude
marks it with a "(Recommended)" suffix, which stays in the label because the answer must echo the label.

`dialog_answer` takes, as well as `value` / `confirmed` / `cancelled`:
- for `permission`: `choice` (a choice id), plus an optional `message` (the reason for a deny, or feedback for the agent);
- for `questions`: `answers: { [questionId]: string | string[] }`.

### Item additions

```ts
// any item: `parent?: string`, the id of the tool item (a subagent) whose run produced it.
// The client nests it under that card, collapsed.
| { id; kind: "plan"; ts; explanation?: string;
    steps: { text: string; status: "pending" | "in_progress" | "completed" }[] }      // a subagent's todo list (always with `parent`), replaced in place; the chat's own plan is `state.plan` (v3.6)
// tool items: status may be "declined" (a permission was denied or the tool was blocked by a rule)
ToolDetail +=
  | { type: "web"; tool: "fetch" | "search"; url?: string; query?: string }
  | { type: "agent"; description: string; agentType?: string }                        // subagent (Claude Agent/Task, Codex collab)
```

### Ops

| op | args | notes |
|---|---|---|
| `set_permission_mode` | `mode` | one of `capabilities.permissionModes` |
| `models` | | as before. The list is the provider's, and `set_model` takes that provider's ids |

### The launcher and the registry

- Chat props become `{chat, cwd, provider}`, default `pi`. The host is started as `serve --provider <p>`.
- The registry records `provider`.
- OSC 7501 reports `app=<provider>`.
- The TUI hand-off argv comes from the adapter: `pi --session <f>`, `claude --resume <id>`, `codex resume <threadId>`.


### Built-in commands per provider (v3)

- **Wording.** `state.commands` built-ins depend on the provider. Descriptions use `providerName`, e.g. "/reload restarts Claude Code".
- **Offered by capability:**
  - `thinking` needs `thinkingLevels`;
  - `compact` needs `compact` (its `[instructions]` argument `compactInstructions`; without it, `/compact <text>` is refused);
  - `name` needs `rename`;
  - `fork` needs `fork` (the adapter has `forkPoints` and `fork`);
  - `tui` needs `tui`.
- **Terminal utilities** (`login`, `settings`, `scoped-models`) are offered only when the adapter has an argv for them. The menu entry carries it as `Command.argv`, and the client runs that argv in a terminal in the chat's cwd (no pane: a dialog over the chat shows it), then sends `resume`.
- **What to type** (`Command.input`): for a utility or a TUI command, the client types it into the terminal once the agent is idle (`hc wait`, then `hc send --if idle`), so the person lands on that screen. A TUI command's is `/<name>`; a utility's is the adapter's `tuiInput(name)` (Pi: `/login`, `/settings`, `/scoped-models`; Claude Code: `/config` for `settings`).

  | provider | login | settings |
  |---|---|---|
  | Pi | `pi --no-session` | `pi --no-session` |
  | Claude | `claude auth login` | `claude` |
  | Codex | `codex login` | not offered |

  Pi also offers `scoped-models` (`pi --no-session`).
- **TUI commands**: the agent's commands that work only in its own TUI, from the adapter's `tuiCommands()` (Pi: its built-ins RPC doesn't run, such as `tree`, `export`, `share`, `session`; Claude Code: its terminal-only commands such as `doctor`, `theme`, `statusline`; Codex: its TUI's, such as `init`, `status`, `review`, `diff`, `mcp`; each minus those the chat has its own way for). Offered when `tui`; each is a `/tui`-style hand-off that types `/<name>`.
- **Op `utility {name}`** returns `{argv}`, or errors with "<Agent> has no /<name>".
- An agent command named like a built-in stays hidden. A built-in that isn't offered is sent to the agent as text.


## v3.1: hand-off watch, session conflicts, report senders (feedback round 1)

## ChatState

```ts
phase: … | "conflict";               // new value: another live writer has the session; the agent is not started
handoff: { argv: string[]; terminal: string | null; since: number } | null;
  // set by `handoff` (argv = the TUI command, terminal = null until `handoff_started`), cleared on resume
conflict: { chat: string | null; terminal: string | null; pid: number | null } | null;
  // chat/terminal/pid of the other chat's host (from its session lock);
  // chat: null = an agent process outside any chat (Claude Code's ~/.claude/sessions registry, Codex "active writer"; pid null when Codex doesn't say)
queue: { steering: string[]; followUp: string[];
         steeringFrom?: (string | null)[]; followUpFrom?: (string | null)[] };
  // aligned with the texts: the `from` of an `hc send` report (e.g. "t7 review"), null = the user. Present only when some entry has a sender.
```
`handoff` and `conflict` flush immediately (like `phase`).

## Ops

| op | args | data | notes |
|---|---|---|---|
| `handoff` | | `{sessionFile, argv}` | as before, plus: `state.handoff` is set and the host watches the hand-off. Pi's argv is now `["env", "HERDR_CHAT_HANDOFF=<stateDir>/handoff/<chat>.json", "pi", "--session", <file>]`. Asking again during a hand-off returns the same argv. Refused in `conflict` |
| `handoff_started` | `terminal` (the TUI terminal's hc address) | `{}` | from then on the host polls `hc get <terminal> --json` every 2 s. Idempotent: a reloaded mod can send it again. Error if not in a hand-off |
| `resume` | | `{}` | works at any time. From a hand-off: reads `<stateDir>/handoff/<chat>.json`; if its `sessionFile` differs and exists, resumes that one (registry updated, an info notice). If the TUI still runs, resumes anyway with a warning notice. In `conflict`: re-checks, stays in conflict (no error) if still held |
| `take_over` | | `{}` | in `conflict` with another chat: connects to it through its registry, sends `shutdown`, waits for its pid to exit (15 s), then opens the session. Errors: "…outside a chat (pid N). Quit it there, then use resume." when `conflict.chat` is null; "Can't reach the other chat…" / "…did not close…" |
| `new_session` | | `{}` | in `conflict`: leaves it and starts a new session |
| `switch_session` | `path` | `{}` | a path another chat holds → stops the agent, phase `conflict` on that path (timeline emptied). In `conflict`: tries `path` |

## Hand-off watch (host)

- `terminal` reported: `hc` says `finished` or `not_found` → wait until the TUI pid (from the hand-off file) and any process on the session are gone → resume by itself. `hc` errors 5x in a row → falls back to the process watch below.
- No terminal within 60 s: resume when no live process is on the session: the hand-off file's pid, the agent's guard (Claude registry), else a `ps` scan for a pi/claude/codex process whose argv has the session (the argv's last arg).
- Independent of clients: works with no mod connected.
- Refused ops in `handoff`: "Pi is open in the terminal UI (terminal t7). Quit it there, or use resume (Return to chat) to come back."
- Refused ops in `conflict`: "This session is open in another chat (terminal t7). Go to that chat, or use take_over to move it here." / "This session is open in Claude Code outside a chat (pid N). Quit it there, then use resume."

## Built-ins

`transcript` (handler `client`, "Show the plain transcript"), after `copy`, for every provider.

## Host env (tests, tuning)

`HERDR_CHAT_HC` (hc binary, default `hc`), `HERDR_CHAT_HANDOFF_POLL_MS` (2000), `HERDR_CHAT_HANDOFF_GRACE_MS` (60000).

## Notes for the mod

1. Send `handoff_started {terminal}` right after `hc run` returns the TUI's address, and again after a reload if `state.handoff` is set. You can drop the mod's own TUI watch and its `resume` on exit: the host resumes by itself.
2. The settings' `<agent>.tui` replaces the program after the `env K=V…` prefix (Pi's argv starts `env HERDR_CHAT_HANDOFF=…`).
3. Show the "Return to chat" banner from `phase === "handoff"` / `state.handoff`. Show the conflict banner from `state.conflict`: "Go to that chat" when `conflict.chat` is set (registry `<chat>.json` → its terminal), else only "Quit it there"; "Take over" → `take_over`.
4. After `take_over`, the other chat's host sends `bye {reason: "shutdown"}` and exits. Its mod should treat that as the chat being closed.
5. Report cards: the queued user item keeps `from` (source `queued`), and the queue chip can read `queue.steeringFrom[i]`.

## v3.2: the steering and follow-up lanes

Steering goes to the agent as before. **Follow-ups are held by the host**: a
`send {mode: "followUp"}` while the agent works never reaches the agent. When
the run settles, the host sends the oldest one as the next prompt (its user
item has `source: "queued"`), one per run: the next waits for that run to
settle. Between them the terminal status stays `working` (no `done`). The
same for every provider, so remove, edit and move work alike.

- **Stopped or failed run:** the follow-ups are not sent. `abort` returns them
  in `restored`, after the steers. A run stopped from elsewhere, a failed run,
  an agent exit, `resume`, a conflict: they go to `state.editorText` (the
  composer).
- **Idle:** `mode: "followUp"` just sends. A held command (`/compact`, `/name …`)
  runs when its turn comes; one that answers without a run lets the next go.
- **Reconnect:** the held follow-ups are in `state.queue`, so a snapshot has them.
- **Host restart:** they live in the host's memory only and are lost, like the
  steers in the agent's queue (the agent restarts too).

### ChatState

```ts
queue: {
  steering: string[]; followUp: string[];          // the texts, oldest first; followUp = the agent's own, then the host's
  // Present when a lane has something, aligned with the texts:
  steeringIds?: (string | null)[]; followUpIds?: (string | null)[];  // the host's message id; null = not the host's (no ×, ⇄ or edit)
  steeringRemovable?: boolean[]; followUpRemovable?: boolean[];      // the host can take it back now (show ×, allow edit and ⇄)
  steeringFrom?: (string | null)[]; followUpFrom?: (string | null)[]; // as in v3.1
};
```

Which steers can be taken back, per provider (`ProviderAdapter.canRemoveQueued` / `removeQueued`):

| Provider | How | When |
|---|---|---|
| Pi | `clear_queue`, then the others re-sent as steers, in order | every entry of Pi's queue is the host's (it has their text and images) |
| Claude Code | `control cancel_async_message {message_uuid}` | until the CLI dequeues it (`cancelled: false` → "Too late") |
| Codex | no: `turn/steer` has no way back | never; only a follow-up the adapter holds (sent while compacting or between turns) |

Held follow-ups can always be taken back.

### Ops

`message`, not `id`: `id` is the request's own.

| op | args | data | notes |
|---|---|---|---|
| `queue_remove` | `message` (an id from `state.queue`) | `{}` | the row's ×. Errors: "That message is no longer queued", "<Agent> can't take back a message it already has…", "Too late: <Agent> already took that message." |
| `queue_edit` | `message` | `{text, images: string[]}` | the row leaves the queue; the client puts `text` and the image paths in the composer. Sending again queues it anew |
| `queue_move` | `message`, `to: "steer" \| "followUp"` | `{}` | the row's ⇄. A follow-up is sent as a steer now; a steer the agent gives back joins the follow-ups' tail. Already in that lane: nothing happens |

## v3.3: sub-agent chats (no wire change)

The wire protocol is unchanged. What's new is how a host starts and how the mod
finds and treats it ([research/subagent-chat.md](research/subagent-chat.md)).

### The host as a sub-agent: `herdr-chat-host run`

`bin/herdr-chat-subagent [--provider pi|claude|codex] [--session <f>] [--cwd <d>] [-- <agent args>]`
(= `herdr-chat-host run …`) is what a parent agent's `hc run` starts, directly or
through the hc templates `pi-chat`, `claude-chat`, `codex-chat`. It `serve`s with:

- `--chat c-<8 hex>`: a fresh id each time (`--chat` is refused: a known id resumes that chat's session);
- `--state-dir ${HERDR_APP_HOME:-~/.config/herdr-app}/data/herdr-chat`, where the mod reads the registry;
- the agent from install's `mods/chat/config.json` and the person's `data/herdr-chat/settings.json`
  (host/settings.ts: `<agent>.command`, `<agent>.args` before the caller's args, `env` and
  `<agent>.env` for keys the caller didn't set), and `node` and `hc` from install's config;
- `--cwd`: the terminal's folder unless given.

Before it serves, it labels its own terminal (`hc label $HC_TERMINAL_ID …`):

| Label | Value | Read by |
|---|---|---|
| `herdr-chat.chat` | the chat id | the mod (`hostTerminal`), chat-agents, chat-menu |
| `herdr-chat.role` | `subagent` (a chat's own host: `host`) | `sweepOrphans` ends only `role=host` terminals |
| `herdr-chat.provider` | `pi` / `claude` / `codex` | the dialog's `provider` prop |

A failed label is a `! hc label …` line on the transcript; the host serves its parent anyway.
The transcript's second line is a hint: `sub-agent chat · in Herdr: right-click → Open as chat`.

### Mod props for a sub-agent's chat

| Props | Where | The view |
|---|---|---|
| `{chat, peek: <address>, provider?}` | a `dialog` overlay 0.8 × 0.8 (chat-agents' row click, chat-menu's Open as chat); `then: "tab"` goes straight on to Open as tab | no place lookup, no layout-document writes, no tab rename, no seen marks |
| `{chat, subagent: <address>, provider?, cwd?}` | a tab (Open as tab): `tab.new` in the parent's space, the chat pane alone | the host is never adopted as the tab's pane (closing a tab ends its panes' terminals) |

Both: the connection only attaches (never starts a host); `close()` never reaps,
and `healHost` never restarts, a host that has a `parent`; hand-offs (`/tui`,
`/login`…) are refused with a hint; a gone host shows "The sub-agent ended" with
no Restart; the header bar shows name, status, "from <parent>" (and in the
dialog ↗ Open as tab, ✕). In the dialog Esc stops a run, cancels a dialog or
closes a menu as in a tab, and closes the dialog when there's nothing to stop.
The dialog's debug dump is `debug/<chat>.peek.json`. Commands:
`chat.click:peek:tab|peek:close`, `chat-agents.peek:<address>` (a row's
click), `chat-agents.menu:<address>` (the right-click menu for a terminal),
`chat-menu.pick:<n>` (its n-th chat item).

## v3.4: the branch (additive)

### ChatState

```ts
git: { name: string;             // the branch, or the short commit when detached
       detached: boolean }
   | null;                       // null: the folder isn't in a repo (or there's no git)
```

The host (`host/git.ts`) reads it when the agent starts, when a run settles
(a repo the agent made), and when the repo's `HEAD` changes, so a switch
from the agent's bash or another terminal shows without a turn. Read-only:
no op switches branches. The mod shows it at the right end of the hint line
under the composer; a click copies it.

## v3.5: updates (additive)

- **The host's build.** `welcome.host` is `{pid, version, build, startedAt}`: `version` from package.json, `build` a hash of the host's own code (`host/build.ts`), `startedAt` the process start (ms). The registry records `version` and `build` (it has `startedAt`). `herdr-chat-host build` prints `{version, build}`; the install writes them into `mods/chat/config.json` with `installedAt` (ms), `channel` (`release` when the one-liner installed it, else `clone`) and `update` (the command that updates a release).
- **An outdated chat.** A host that started before `installedAt` and whose `build` differs (or has none: before 0.3) runs older code. A host started after the install never counts, so in a clone, edited code isn't an update until `./install.sh`. The chat (`mods/chat/update.js`, one `Updater`) restarts it on the same session (`shutdown`, then a new host, as `healHost` does) once the person asks and the chat is quiet: idle (or the agent exited), no dialog, nothing queued, no live sub-agent of its own (their reports go to the host's terminal). Never a sub-agent's chat. One try per install build.
- **The questions** (`mods/new-chat/update.js`, the layout's floating block): after an install, "Restart N chats?" (Restart sets the shared `herdr-chat.update.restart` to the build: every chat restarts when quiet; Later sets `herdr-chat.update.later`: a bar in each chat, its Restart and `/reload` still work). For a release install, once a day (or `new-chat.update-check`), GitHub's latest release (tags `X.Y.Z` only): "X is available" → Update runs `update --version X` in a core terminal, with a PATH holding the node, hc and agents config.json names (a core terminal lacks the login PATH). The update is done when that terminal ends (shared `herdr-chat.update.running`, then `.result`); on success the restart question follows. Settings: `"updates": {"check": false}` turns the lookup off; `feed` points it elsewhere.
- **Shutdown** cuts a client that doesn't close its side within 500 ms, so a restart never waits on a client.

## v3.6: the plan (state, not an item)

### ChatState

```ts
plan: { explanation?: string;
        steps: { text: string; status: "pending" | "in_progress" | "completed" }[] }
    | null;                      // null: no plan (Pi has none)
```

The agent's current plan: Claude Code's task list or TodoWrite, Codex's `update_plan`. The host keeps one per chat (`Timeline.plan`; the timeline reports each change and the next flush sends it). A new plan (a `plan` event) replaces it, whichever tool made it. A plan with no steps clears it. A plan whose steps are all completed stays until the next top-level user message, which clears it. A message the agent rejects or handles without a run puts it back. History rebuilds it as live:
- Claude Code's transcript. A plan made by a subagent's step (the shared task list) is placed in time against the top-level items, so a background agent's change after the next user message comes after it.
- Codex's rollout files (`thread/turns/list` has no item for `update_plan` calls): each call after the user message of its turn it came after, a steer being a second one. A fork's history is its source's rollout up to the fork (`session_meta.history_base`).

A subagent's plan (a `subagent_plan` event, with `parent` and a `key`) is a `plan` item with `parent`, a card in its group, replaced in place per key. One whose subagent card isn't on the timeline (cut from the history) is dropped.

### The marker row

The transcript gets a notice (`source: "plan"`, `level: "info"`) instead of a card, at most one per turn (from one top-level user message to the next):
- `Plan created · N steps` when the plan starts: no plan before, or no step text carried over from the last one.
- `Plan updated · N steps` when steps were added, removed or renamed.
- `Plan cleared` when a plan with no steps ends it.
- A later change in the same turn edits that row to the turn's last plan (`created` wins). A change of status or explanation only makes no row.

The mod shows the plan as a strip above the composer (`2/5`, a progress bar, the step in progress, else the first pending one). A click opens the full list above it, another closes it. All done: `N/N done`.

## v3.7: image sizes (additive)

- Items with saved images carry `imageSizes`: user items next to `imagePaths`, tool items next to `images`. Entry `i` is the pixel size `{w, h}` of path `i` as `image()` draws it, read by the host from the image's header when it saves it (`host/imagesize.ts`: PNG, JPEG, GIF, WebP; a JPEG whose EXIF orientation turns it a quarter, 5–8, has w and h swapped). It is `null` when the header can't be read. Inside the host an item keeps one `{path, size}` list (`imageFiles`); `toWire()` splits it into these arrays.
- The mod draws each thumbnail at that aspect ratio from the first frame (`cards.js` `images()`), within 320 × 320 points and 60 % of the column, never enlarged. A row with images then has its final height when it first appears, so the rows above it never jump. The size also goes to the viewer when a thumbnail is enlarged.
- The composer's images carry theirs too: `clipboard_image` and `attach_image` answer `{path, size}`, the size read from the attachment's bytes. A chip keeps its fixed 64 × 48 box (the composer's height doesn't wait on the host's answer), so its size only goes to the viewer when the chip is enlarged. A message sent with chips gets sizes as any user item does, from the images the host saved for it.
- The mod can't read raster files itself (the manifest grants no `fs.read`). An image without a size (a `null`, or a host older than v3.7) gets a 16:10 box as wide as a thumbnail may be, and the viewer opens it at a 1600 × 1000 guess. SVGs (mermaid blocks) are still sized by the mod, from the file's `viewBox`.

## v3.8: remote chats, the relay and the bridge (additive)

A chat can run on another machine that herdr-core links to (`hc machine add`). Its host then runs there, and no port opens on that machine for it: the chat's records cross core's machine link inside a terminal's PTY. Local chats are unchanged.

```
mod ──WebSocket 127.0.0.1──▶ relay ──hc connect (framed)──▶ core ══machine link══▶ core on <m>
                                                                              │ terminal (PTY)
                                                                              ▼
                                         host ◀──Unix socket 0600── bridge <chat>
```

### The host's Unix socket

- The host also serves its records on `<stateDir>/chats/<chat>.<pid>.sock` (its own pid), mode 0600 in a 0700 directory, as JSONL exactly like the TCP port (`hello` first, then records; no keepalive pings).
- A local host serves it in addition to the two loopback ports, which stay as they are. A remote chat's host runs `serve --socket-only`: the socket only, no TCP and no WebSocket port (the registry's `port` and `wsPort` are `null`). With `--socket-only` a host that can't listen on the socket exits 1.
- The registry records it: `"socket": "<abs path>" | null`. It is `null` until the socket listens, when it can't listen (the host logs why, and serves TCP and WebSocket only), and after a clean exit.
- Named by pid, so a host never removes another's socket: a new host for the same chat binds its own path, and the old one's exit removes only the old path. On exit a host clears the registry entry only while the entry still names its pid. Before listening, a host removes the sockets of this chat's dead hosts (a SIGKILL leaves one), and only paths that are sockets.

### `herdr-chat-host relay --machine <m>`

Runs where the Herdr app runs, one per linked machine. It gives the mod the same WebSocket a local host gives it, on `127.0.0.1` only.

```
herdr-chat-host relay --machine <m> [--state-dir D] [--host CMD] [--node PATH]
                      [--remote-state-dir R] [--hc PATH] [--ping-ms N] [--dead-ms N]
```

- `--machine`: core's name for the machine (`[\w.-]+`).
- `--state-dir`: the local state dir (the mod's `appHome() + "/data/herdr-chat"`). The relay writes `relays/<m>.json` (0600, atomic) and logs to `relays/<m>.log` (at most 1 MiB; then it moves to `relays/<m>.log.1` and starts over).
- `--host`: the `herdr-chat-host` command on the machine (default `herdr-chat-host`). `--node`: `HERDR_CHAT_NODE` for it there.
- `--remote-state-dir`: the hosts' state dir on the machine, relative to its home (default `.local/state/herdr-chat`).
- `--hc`: the `hc` binary (default `$HERDR_CHAT_HC`, else `hc`). The relay reaches core with `hc connect`, so it uses whatever session `hc` uses (`HC_SESSION`).
- `--ping-ms` (5000) and `--dead-ms` (20000): the link's ping interval and silence limit.
- `HERDR_CHAT_RELAY_SETUP_MS` (20000): how long a connection's setup may take.
- One relay per machine: it takes `relays/<m>.lock` (created exclusively, holding its pid) before it listens. While that pid lives, a second relay exits 1 (`already serves machine`). A lock whose pid is dead (a SIGKILLed relay) is taken over.
- SIGTERM, SIGINT and SIGHUP close every connection (1001), kill their bridges (each kill waits at most 10 s for core), and, if the lock is still its own, rewrite the registry with `pid: null, wsPort: null` and remove the lock. An error in one connection is logged; it never ends the relay.

The relay registry:

```json
{ "v": 1, "machine": "lab", "pid": 4242, "wsPort": 51235, "startedAt": 1793700000000, "version": "0.9.0", "build": "<hash>" }
```

The mod connects to `wsPort` as it does to a host's, with one more field in `hello`: `"chat": "<chat id>"`. The relay keeps one `hc connect` for all its connections, opened on first use and again after it closes; when it closes, every connection closes with 4001. Then, per WebSocket connection:

1. `hello` within 5 s, with `chat` and `token`; else close 4003. At most 8 connections set up at once; the ninth closes 1013. Until the bridge is synced the relay holds at most 1 MiB of the mod's records; more closes 4003.
2. The relay reads `<remote-state-dir>/chats/<chat>.json` on the machine (`file.read`). No entry, an entry without a token (or an empty one), or a wrong token (compared in constant time) closes 4003, before anything runs on the machine. So does an entry with no `pid` (its host exited).
3. It runs `herdr-chat-host bridge <chat> --state-dir <remote-state-dir> --ping-ms … --dead-ms …` there (`terminal.run`, with `no_parent`, `no_notify`, `rm`, labels `herdr-chat.role=bridge` and `herdr-chat.bridge=<chat>`), attaches its terminal, and syncs (below). A bridge has no `herdr-chat.chat` label: the mod finds a chat's host by that label, and a bridge is not one.
4. It forwards the mod's `hello`, and from then on carries records both ways. The mod's `{"t":"ack"}` stays with the relay: the relay keeps the host's ack window towards the mod (at most 4 messages unacknowledged, as a host does), and a JSONL socket needs no acks.
5. When the WebSocket closes, the relay kills the bridge's terminal. A connection that ends while core is still starting the bridge kills it once its address comes back.

Close codes, each with a fixed reason (the detail goes only to the relay's log, so a refused client learns nothing of which chats exist):

| Code | Reason | When | The mod |
| --- | --- | --- | --- |
| `4001` | `resync` | the link broke, the bridge ended, core's link closed, or the bridge stopped reading for 64 MiB | reconnects at once; a new bridge, and the snapshot after `welcome` replaces all it had |
| `4003` | `refused` | a bad or missing hello, no registry entry, a wrong token, no host (its entry has no pid, or the bridge found none), too much before sync | stops: retrying gets the same answer |
| `1013` | `busy` | 8 connections already setting up | reconnects later |
| `1011` | `setup failed` | setup failed or timed out | reconnects later |
| `1001` | `relay stopping` | the relay got a stop signal | reconnects later |

A resync is the only recovery from a broken link: the relay closes with 4001 and the mod reconnects. Records never resume in the middle; a snapshot replaces them, so a resync loses or repeats no turn.

A relay that dies leaves the host and its agent running; the bridge it started stops getting pings and exits after `--dead-ms`. A new relay serves new connections; it doesn't adopt old bridges.

### `herdr-chat-host bridge <chat>`

Runs on the chat's machine, in the terminal the relay starts; nobody else needs to run it.

- `--state-dir` relative to `$HOME`. It logs to `<stateDir>/chats/<chat>.bridge.log` (capped like the relay's). Nothing else reaches its terminal: its stderr goes to that log.
- It sets its PTY raw (`stty raw -echo`; exit 2 if it can't).
- It reads the registry and connects to the socket its host's pid names (`<chat>.<pid>.sock`, never the path the entry gives). No pid, a dead pid, or a socket it can't connect to: it prints `{"t":"nohost","v":1}` and exits 4. The relay closes 4003.
- Connected, it prints the READY line and waits for SYNC. No SYNC within `--dead-ms` (the relay went away during setup): exit 8.
- After SYNC it prints SYNCED and carries records: the host's JSONL lines onto the link, the link's records onto the socket.
- It exits when the host's socket closes (0), on a socket error after sync (5), when the link breaks or goes silent for `--dead-ms` (6), when its terminal's input ends (0), on SIGTERM, SIGHUP or SIGINT (0), or on an error of its own (7). Its last log line says why, and how often the link's window filled and the most it had in flight.
- Flow control: it stops reading the socket while more than 4 MiB of records wait for the link's window, and holds its acks while more than 4 MiB wait to be written to the socket. A write to the PTY that would block waits (1 to 50 ms, doubling) and retries.

### The link (`host/relaylink.ts`)

A PTY is not a clean pipe: core may inject a repaint (it starts with `\x18\x1b[!p`) after its machine link drops or when a viewer falls more than ~4 MiB behind; a line may be lost; someone may type into the terminal. So:

- Every line is one JSON object in printable ASCII (`0x20`–`0x7e`) ended by `\n`, at most 512 KiB.
- Handshake (no `s`): the bridge prints `{"t":"ready","v":1}`. The relay, once it sees it, sends `{"t":"sync","n":"<nonce>"}`; the bridge answers `{"t":"synced","n":"<nonce>"}`. Anything before SYNC (on the bridge) or before SYNCED (on the relay) is ignored: it is the terminal's, not the link's. `{"t":"nohost","v":1}` instead of READY: no host, refused.
- After SYNCED, every line carries `s`: 1, 2, 3… per direction.
  - Data: `{"s":N,"d":"<base64>"}`. A record (one JSONL line of the chat protocol, UTF-8, without its `\n`) goes in chunks of at most 192 KiB before base64; all but the last chunk carry `"c":1`. A record is at most 8 MiB.
  - Ack: `{"s":N,"t":"ack","n":<bytes>}`, the cumulative bytes of data lines received (each line with its `\n`). Sent every 64 KiB and at each record's end, and only while the receiver's consumer keeps up (the relay's WebSocket has at most 1 MiB waiting; the bridge's socket at most 4 MiB). One held back goes out with the next ping tick once the consumer catches up.
  - Ping: `{"s":N,"t":"ping"}`, when nothing else went out for `--ping-ms`.
- A sender sends a data line only if, with it, at most 1 MiB of data lines are unacknowledged: never more than 1 MiB in flight, well under core's ~4 MiB. A record larger than the window crosses window by window.
- Any other byte, a line that isn't JSON or has the wrong keys, a sequence gap, an ack beyond what was sent, bad base64, or no line for `--dead-ms` breaks the link. The bridge exits 6; the relay closes the WebSocket with 4001.
