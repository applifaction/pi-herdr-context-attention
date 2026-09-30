# Pi Herdr Context Attention

**Know when a Pi agent needs compaction—not just when it stops working.**

A [Pi](https://pi.dev) extension that adds a dedicated **`⚠ Context full`** row to
[Herdr](https://herdr.dev)'s Agents sidebar when a context-window error remains
unresolved. Since v0.2, it uses display-only metadata: **no native blocked `×`,
no fabricated agent state, and no changes to other plugins' status labels.**
During compaction, the same row becomes **`⌛ Compacting context`**.

[Quick start](#quick-start) · [Behavior](#behavior) · [Troubleshooting](#troubleshooting) · [Testing](#testing)

## Quick start

### 1. Install the extension

Requirements: Pi running interactively inside Herdr, Herdr's official Pi integration,
and Node.js 22.19+. Tested on Linux with Pi **0.84.1**, Herdr **0.9.1**, and Herdr Pi
integration **v9**. Pi must support `agent_settled`; Herdr must support metadata tokens.

Clone this repository, enter its directory, then run:

```bash
# Skip this if the official integration is already installed.
herdr integration install pi
pi install .
```

Install only one copy. Remove an older manually installed copy or symlink from
`~/.pi/agent/extensions/` before switching to a package installation. Do not remove
Herdr's managed `herdr-agent-state.ts`.

### 2. Add the warning row

Back up `~/.config/herdr/config.toml`. Add the custom token row to your existing
`[ui.sidebar.agents].rows`, preserving the other rows:

```toml
[ui.sidebar.agents]
rows = [
  ["state_icon", "machine", "workspace", "tab"],
  [{ token = "$pica_context", fg = "#b58900", bold = true }],
  # Keep any other rows here, e.g. Priority+'s "Antwort offen" row.
]
```

Do not duplicate the TOML section. If you use `rows_by_agent`, add the row to the
relevant override too. The row disappears automatically when its token is absent.
This config controls the expanded desktop sidebar, not compact/mobile layouts.

```bash
herdr server reload-config
```

The warning has its own token rather than competing for `state_text`. Existing
rules that hide non-`Antwort offen` labels therefore cannot hide it, and a later
Priority+ label update cannot overwrite it. Priority+'s reply reminder remains
independent and may appear on a separate row.

### 3. Activate it in existing Pi sessions

> [!IMPORTANT]
> **Installing, changing files, or running `git pull` does not reload a running Pi
> process.** In each already-running session, wait until it is idle, then execute
> `/reload`. New sessions load the extension automatically.

Verify the running session—not just the files on disk:

```text
/reload
/herdr-context-status
```

The diagnostic command reports the loaded version, whether Herdr reporting is
active, whether an unresolved overflow exists, whether compaction is running, and delivery status:

```text
Context Attention v0.3.0 loaded; Herdr: enabled; context full: true; compacting: false; delivery: acknowledged
```

`acknowledged` confirms the metadata API accepted the latest update. The sidebar
row must still be configured as above. The status command itself makes no model call.

If upgrading from v0.1, reloading also releases the old extension's native blocker.
No Herdr restart or `herdr plugin link` is needed: this is a **Pi extension for
Herdr**, not a separate Herdr workflow plugin.

## Behavior

| Situation | Result |
| --- | --- |
| Manual or automatic compaction is running | Shows `⌛ Compacting context` instead of the warning |
| Pi settles with an unresolved overflow | Shows `⚠ Context full` |
| A new agent run starts | Clears the warning while work proceeds |
| That retry fails or aborts without recovery | Restores the warning when Pi settles |
| Compaction or an assistant response succeeds | Clears the unresolved overflow |
| Compaction fails or is cancelled | Restores `⚠ Context full` if the overflow remains; otherwise clears the row |
| `/reload`, `/resume`, or `/tree` | Reconstructs state from the active branch |
| RPC/JSON/print mode, or execution outside Herdr | Does nothing |

> [!NOTE]
> The extension never runs `/compact`, calls a model, changes auto-compaction
> settings, writes session history, or steals another extension's blocker.
> When warned, open the session and resolve the error—for example with `/compact`.

## How it works

```text
Structured Pi assistant error
  → Pi's provider-aware overflow detector
  → agent_settled (automatic recovery has finished)
  → pane.report_metadata: pica_context = "⚠ Context full"
  → custom Agents sidebar row
```

The extension reads Pi lifecycle events, not rendered terminal text or token
percentages. Reports use a dedicated source and token, with bounded socket timeouts,
matching JSON acknowledgements, retries, and serialized updates. The token has a
45-second lease, renewed every 15 seconds while required. Shutdown awaits its
clear; a crashed process cannot leave the warning permanently behind.

For automatic compaction, progress follows `session_before_compact`, its abort
signal, `session_compact`, and `agent_settled`. Pi 0.84.1 does not expose the manual
compaction failure/end event to extensions. A session-scoped, in-memory observer
therefore wraps the public SDK `AgentSession.compact()` promise to detect its
completion, including failures before the extension hook. It preserves the
original arguments, results, errors, and cancellation behavior and detaches on
shutdown. No installed Pi files are modified. This compatibility bridge should be
rechecked when upgrading Pi or combining other wrappers of that SDK method.

Native lifecycle and sorting remain under Herdr's control. Other labels, tokens,
and genuine approval blockers are untouched. **`pica_context` is reserved:** Herdr
token names are global per pane, not isolated by reporter.

### Limits

- A process crash or hang before `agent_settled` is not detected as context overflow.
- Silent provider truncation and errors unknown to Pi's overflow detector are not detected.
- This is neither an early-warning threshold nor a general error notifier.
- An unreloaded old Pi process cannot emit new extension events; no external watcher is installed.
- A disconnected or stalled extension may temporarily lose its leased warning until delivery recovers.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No warning in an old session | Run `/reload` when idle, then `/herdr-context-status`. An unknown command means the extension is not loaded. |
| Delivery acknowledged, no sidebar row | Add `$pica_context`, check agent-specific overrides, and reload Herdr config. |
| Delivery failed or pending | Check the Herdr socket, pane identity, and official Pi integration; the publisher retries. |
| Native `×` still appears | Reload any v0.1 instance. A genuine approval blocker owned elsewhere can still legitimately show `×`. |
| `Antwort offen` is also visible | Expected: it is Priority+'s independent workflow reminder, not the context warning. |

To uninstall a package, run `pi remove <source>` using the source shown by `pi list`,
then `/reload` when idle. For a manual install, move its directory/symlink outside
Pi's extension discovery path, then reload. Remove the optional sidebar row too.

## Testing

With Pi installed globally through npm and Herdr's official Pi integration installed:

```bash
npm test
```

The regression suite loads the real installed native integration, simulates Pi
lifecycle events, and captures isolated socket requests. Transport tests cover
fragmented acknowledgements, rejected/mismatched responses, timeouts, retries,
rapid transitions, and shutdown. No project dependency installation is required;
tests use the `jiti` and Pi modules supplied by Pi. Manual failure coverage invokes
the real installed SDK method without a model, and checks that its error is preserved
while the progress badge resets.

Optional read-only replay of an actual session's historical overflow branch:

```bash
PI_REPLAY_SESSION=/absolute/path/to/session.jsonl npm test
```

Do not commit private sessions. Test-only overrides: `PI_TEST_PACKAGE_DIR` for the
Pi package directory (default: `$(npm root -g)/@earendil-works/pi-coding-agent`),
`HERDR_PI_INTEGRATION_PATH` for the installed native extension, and
`PI_CODING_AGENT_DIR` for its default agent directory (`~/.pi/agent`).

### Real TUI test

On Linux, with `herdr`, `pi`, and [uv](https://docs.astral.sh/uv/) available:

```bash
npm run test:tui
```

This starts its **own** Herdr server/client and an offline, credential-free Pi in
temporary HOME/XDG directories. It runs the actual metadata publisher, decodes
Herdr's TUI with `pyte`, and verifies the warning/progress transitions, unchanged native state,
foreign-label coexistence, recovery, and cleanup. It never connects to your live
server or submits an LLM prompt. Evidence is saved under `.local-validation/`.

## Project layout

```text
index.ts                    Pi lifecycle adapter and diagnostic command
metadata.ts                 Leased, acknowledged Herdr metadata publisher
compaction-observer.ts      Scoped manual-compaction SDK compatibility bridge
tests/integration.test.mjs   Lifecycle and installed-integration regressions
tests/metadata.test.mjs      Socket delivery and cleanup tests
tests/tui_smoke.py           Isolated real Herdr TUI proof
```
