# Pi Herdr Context Attention

**Know when a Pi agent needs compaction—not just when it stops working.**

A small [Pi](https://pi.dev) extension that shows [Herdr](https://herdr.dev)'s native
**Needs attention** indicator when a context-window error remains unresolved.
It works alongside Herdr's official Pi integration without modifying it.

[Quick start](#quick-start) · [Behavior](#behavior) · [How it works](#how-it-works) · [Testing](#testing)

## Why this exists

A Pi agent can reach its context limit and stop with an error such as:

```text
Your input exceeds the context window of this model.
```

Without a dedicated signal, that session may not stand out in Herdr's Agents
sidebar. This extension marks it as needing attention so you can find it and
run `/compact` or otherwise recover the session.

- **Native indicator:** uses Herdr's existing `blocked` state, not a separate widget.
- **Recovery-aware:** waits for automatic compaction, retries, and queued continuations before raising attention.
- **Session-aware:** restores unresolved errors after `/reload` or `/resume`, and follows the active `/tree` branch.
- **Isolated:** headless subagents cannot mark their parent pane as blocked; other extensions' blockers remain intact.

> [!NOTE]
> This extension only reports state. It does not run `/compact`, call a model,
> change auto-compaction settings, or write to your session history.

## Quick start

### Requirements

- Pi running interactively inside Herdr.
- Herdr's official Pi integration installed and enabled.
- Node.js **22.19+** for the npm-based Pi installation and test runner.

Tested on Linux with **Pi 0.84.1**, **Herdr 0.9.1**, and **Herdr Pi integration v9**.
The integration must support the `herdr:blocked` event; Pi must support `agent_settled`.

### Install

Clone this repository, then run from its directory:

```bash
# Skip this if Herdr's official Pi integration is already installed.
herdr integration install pi

# Register this checkout as a global Pi package.
pi install .
```

Pi also supports installation directly from GitHub: use `pi install <repository-url>`
with this repository's HTTPS URL.

New Pi sessions load the extension automatically. In an existing session, wait
until the agent is idle, then run:

```text
/reload
```

No Herdr restart, build step, or `herdr plugin link` is required. This is a
**Pi extension for Herdr**, not a Herdr workflow plugin.

> [!IMPORTANT]
> Install only one copy. If you previously placed this extension in
> `~/.pi/agent/extensions/`, move that copy or remove its symlink before switching
> to a package installation. Leave Herdr's own `herdr-agent-state.ts` in place.

### Use and remove

No configuration is needed. When attention appears, open the affected Pi session
and resolve the context error—for example with `/compact`. The marker clears
after successful compaction or a successful assistant response.

The current attention label is German:
`Context-Limit erreicht – /compact erforderlich` (“Context limit reached — /compact required”).

To remove a package installation, run `pi remove <source>` using the same source
shown by `pi list`, then `/reload` when idle. For a manually installed directory
or symlink, move it outside Pi's extension discovery directory before reloading.

## Behavior

| Situation | Result |
| --- | --- |
| Context overflow while Pi is still trying to recover | No new attention marker yet |
| Pi settles with an unresolved context overflow | Acquires a native `blocked` marker |
| A new agent run starts | Releases this extension's marker while the run proceeds |
| That retry aborts or fails without recovery | Restores attention when Pi settles again |
| Compaction or an assistant response succeeds | Clears the unresolved overflow and its marker |
| Manual compaction fails or is cancelled | Keeps the existing attention marker |
| Session reload, resume, or tree navigation | Reconstructs state from the active branch |
| Headless mode or execution outside Herdr | Does nothing |

Releasing this extension's marker does not clear a blocker owned by another extension.
During a manual compaction attempt, an existing marker remains until compaction succeeds.

## How it works

```text
Pi assistant error
  → Pi's provider-aware context-overflow detector
  → agent_settled (automatic recovery has finished)
  → herdr:blocked event
  → official Herdr Pi integration
  → native Needs attention indicator
```

The extension observes structured message and session events. It does not scrape
terminal output, guess from token percentages, or send competing socket reports.
The official integration remains responsible for pane identity, session references,
and delivery to Herdr.

Each blocked acquisition has a matching release. Successful compaction, successful
responses, and branch changes update the in-memory state; shutdown releases the
extension's own blocker.

### Limits

- A process crash or hang before `agent_settled` is not detected.
- Silent provider truncation and error messages unknown to Pi's overflow detector are not detected.
- This is not an early-warning threshold indicator or a general error notifier.
- Automated tests verify the outgoing Herdr status request, not the visual rendering of the sidebar icon.

## Testing

The suite loads your installed Herdr Pi integration and checks its actual
`pane.report_agent` requests against an isolated local socket. Pi lifecycle events
are simulated; no live pane or agent is controlled.

With Pi installed globally through npm and the Herdr integration installed:

```bash
npm test
```

No project dependency installation is required for this test setup: the runner
uses the `jiti` and Pi AI packages supplied by your Pi installation. The current
socket-based test harness targets Linux/macOS; verification was performed on Linux.

The suite covers recovery, reload order, branch navigation, blocker ownership,
shutdown, unrelated errors, and headless isolation. An optional real-session
replay is skipped unless explicitly enabled:

```bash
PI_REPLAY_SESSION=/absolute/path/to/session.jsonl npm test
```

Replay reads the historical branch ending in the last matching context-overflow
error without modifying the file. **Do not commit private session files.**

For nonstandard installations, set these test-only variables:

| Variable | Purpose / default |
| --- | --- |
| `PI_TEST_PACKAGE_DIR` | Pi package directory; defaults to `$(npm root -g)/@earendil-works/pi-coding-agent` |
| `HERDR_PI_INTEGRATION_PATH` | Path to `herdr-agent-state.ts`; defaults to Pi's agent directory under `extensions/` |
| `PI_CODING_AGENT_DIR` | Pi agent directory override; defaults to `~/.pi/agent` |
| `PI_REPLAY_SESSION` | Optional session JSONL for read-only replay |
| `BASELINE_ONLY` | Omits this extension to reproduce the original failure |

To check the original regression against integration v9, this command should fail
with `idle` instead of the expected `blocked`:

```bash
BASELINE_ONLY=1 node --test \
  --test-name-pattern='real Herdr integration: settled' \
  tests/integration.test.mjs
```

## Project layout

```text
index.ts                    Extension entry point and state tracking
package.json                Pi package manifest and test command
tests/integration.test.mjs  Native-integration regression tests
```
