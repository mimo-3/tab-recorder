# tab-recorder

Record Chromium tabs from the CLI, including background tabs, using CDP screencast, Native Messaging and a user-private Unix socket. Dependency-free Node.js 22+, macOS and ffmpeg are required. No audio is captured.

## Install

1. Keep this checkout at a stable absolute path. Enable Developer mode in `chrome://extensions` and load `extension/` unpacked in Aside or Google Chrome.
2. Run `npm link`, or use `node bin/tab-recorder.mjs` directly.
3. Run `tab-recorder install --browser aside`. Supported browsers: `aside`, `chrome`, `all` (default). Reload the extension or restart the browser afterward.
4. To record in several browser profiles, load `extension/` unpacked in each profile. One `install` covers every profile of that browser.

`install --ffmpeg <path>` selects ffmpeg explicitly. Otherwise installation searches only absolute PATH entries and resolves symlinks. Installation prints the pinned ffmpeg path. Reinstall after updating Node.js or moving Node, ffmpeg or this checkout.

Fixed extension ID: `bjidelnfdjcggjdogogicbahlcgigodk`. Only the public key is included.

## Commands

```sh
tab-recorder tabs
tab-recorder start --tab active --out ./new-frames --max-duration 600
tab-recorder status
tab-recorder stop --session <id> -o ./capture.mp4
tab-recorder record --tab example.com --duration 10 -o ./demo.mp4
tab-recorder discard --session <id>
tab-recorder encode ./new-frames -o ./recovered.mp4
tab-recorder uninstall --browser aside
```

- `tabs`: list tab IDs, titles and URLs from every connected profile. Each row has a `profile` object (`browser`, `profileDir`, `profileName`, `instanceId`).
- `--profile <value>`: select one profile by display name, profile directory (`Default`, `Profile 1`) or instance ID prefix. Works with every host command. Without it, `start`/`record` use the only connected profile, or the profile that has the numeric `--tab` ID; anything ambiguous fails and asks for `--profile`. `stop`/`discard --session` find the owning profile automatically.
- `start`: return a session ID and frames directory immediately. `--tab` is required: `active`, a numeric ID or a URL substring matching exactly one tab. Optional `--max-duration <seconds>` stops and encodes automatically; there is no default safety timer.
- `record`: requires `--tab` and `--duration <seconds>`. The host owns the timer; the CLI keeps one connection open until encoding finishes. Each connection owns its session and timer. Disconnecting the CLI (including Ctrl-C, SIGHUP or kill) stops and encodes only that session. Results remain in the frames directory.
- `stop`: stop capture and encode; `--session <id>` selects the session. It may be omitted when exactly one session exists; with multiple sessions, omission returns an error listing them. `-o <file>` chooses the MP4 output. Default: `capture.mp4` inside the frames directory. There is no CLI timeout during stop or record.
- `discard`: stop and release the selected session without encoding; retain frames. `--session <id>` follows the same selection rules as `stop`.
- `encode <dir> [-o <file>] [--ffmpeg <path>]`: encode retained `frames.jsonl` and JPEG files locally without a running host.
- `status`: return an array of all sessions across profiles (empty when idle), including IDs, tab IDs, directories, frame counts, stopped/detached state, errors and `profile`.
- `uninstall`: remove selected browser host registrations and launcher; recordings and extension files remain. Stop capture first.

Capture options for start/record: `--max-width` (integer 2–3840, default 1280), `--quality` (integer 0–100, default 80), `--out <dir>` and repeatable `--pause-extension <id>`. Durations are 0.001–86400 seconds. `--out` must be a new directory; parents may already exist. Relative CLI paths are resolved before sending. Existing output files are never overwritten.

Frames and metadata remain after stopping. A fatal frame-write error or zero frames releases the session and returns an error. An ffmpeg failure keeps the stopped session: fix the issue and retry `stop -o <different-file>`, or use `discard`. After host loss use `encode` on the retained directory.

## Extension pause configuration

Optional `~/.config/tab-recorder/config.json`:

```json
{"pauseExtensions": ["abcdefghijklmnopabcdefghijklmnop"]}
```

`pauseExtensions` is both the allowlist and the default list. The host rejects CLI `--pause-extension` IDs outside it; add an ID to this config first. Only installed, enabled extensions that permit disabling are paused. Tab Recorder cannot pause itself. Recovery IDs are persisted before disabling. Pauses are reference counted per extension: the first session disables it and the last session needing it restores it. Worker/browser restart cleans up all persisted captures and attempts restoration; failed restorations remain pending and missing IDs are discarded. Do not disable/remove Tab Recorder while other extensions are paused.

Pausing extensions reloads the selected tab and can lose page state. It can allow capture when another extension embeds a `chrome-extension://` iframe. Each captured tab shows its own red `REC` badge and title identifying the tab and paused extensions.

## Limits and threat model

- Capture is best effort, not guaranteed 60 fps. Unchanged tabs may emit zero frames. Tabs the browser stops painting, such as a tab hidden behind another tab in its window, emit no frames. Final still duration is retained.
- Debugger permission displays a browser warning. Protected pages, extension iframes or competing DevTools/debugger sessions can prevent attachment. Unexpected detach stops the capture timeline; stop can encode captured frames.
- One native host per browser profile. Each extension instance stores a random instance ID and the host listens on `~/Library/Application Support/tab-recorder/hosts/<instanceId>.sock`. Aside and Chrome profiles can run side by side. The profile name is found by searching the extension's local storage files for the instance ID and may be `null` for a few seconds after first install.
- Each host allows up to four concurrent sessions on distinct tabs. Starting or recording an already reserved tab or exceeding four sessions fails. Stopped sessions retained after encoding failure still count toward the limit until stopped successfully or discarded.
- The extension reconnects to the host automatically. A `chrome.alarms` wake-up every 30 seconds reopens the connection even after the service worker was suspended, so a lost host comes back within about 30 seconds. Sockets of hosts that are gone are removed by the CLI.
- The socket directory uses mode 0700 and each socket 0600. Any process running as the same OS user can request recording through the socket. CDP tab capture does not go through macOS Screen Recording permission.
- Native Messaging `allowed_origins` restricts the extension ID allowed to connect; it does not protect against a modified extension using that ID. The host permits pausing only IDs in the config allowlist. No remote API is provided.

Run `node --test`. Real browser capture, extension restoration, worker restart and ffmpeg output require target-machine verification.

If paused extensions cannot be restored, stopping still encodes the recording and
logs an extension restoration warning (`restoreFailed` in the extension result).
Failed IDs remain saved for a later restoration attempt.
