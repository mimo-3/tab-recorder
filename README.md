# tab-recorder

Record Chromium tabs from the CLI, including background tabs, using CDP screencast, Native Messaging and a user-private Unix socket. Dependency-free Node.js 22+, macOS and ffmpeg are required. No audio is captured.

## Install

1. Keep this checkout at a stable absolute path. Enable Developer mode in `chrome://extensions` and load `extension/` unpacked in Aside or Google Chrome.
2. Run `npm link`, or use `node bin/tab-recorder.mjs` directly.
3. Run `tab-recorder install --browser aside`. Supported browsers: `aside`, `chrome`, `all` (default). Reload the extension or restart the browser afterward.

`install --ffmpeg <path>` selects ffmpeg explicitly. Otherwise installation searches only absolute PATH entries and resolves symlinks. Installation prints the pinned ffmpeg path. Reinstall after updating Node.js or moving Node, ffmpeg or this checkout.

Fixed extension ID: `bjidelnfdjcggjdogogicbahlcgigodk`. Only the public key is included.

## Commands

```sh
tab-recorder tabs
tab-recorder start --tab active --out ./new-frames --max-duration 600
tab-recorder status
tab-recorder stop -o ./capture.mp4
tab-recorder record --tab example.com --duration 10 -o ./demo.mp4
tab-recorder discard
tab-recorder encode ./new-frames -o ./recovered.mp4
tab-recorder uninstall --browser aside
```

- `tabs`: list tab IDs, titles and URLs.
- `start`: return a session ID and frames directory immediately. `--tab` is required: `active`, a numeric ID or a URL substring matching exactly one tab. Optional `--max-duration <seconds>` stops and encodes automatically; there is no default safety timer.
- `record`: requires `--tab` and `--duration <seconds>`. The host owns the timer; the CLI keeps one connection open until encoding finishes. Disconnecting the CLI (including Ctrl-C, SIGHUP or kill) causes the host to stop and encode. Results remain in the frames directory.
- `stop`: stop capture and encode; `--session <id>` optionally checks the session ID. `-o <file>` chooses the MP4 output. Default: `capture.mp4` inside the frames directory. There is no CLI timeout during stop or record.
- `discard`: stop and release the session without encoding; retain frames.
- `encode <dir> [-o <file>] [--ffmpeg <path>]`: encode retained `frames.jsonl` and JPEG files locally without a running host.
- `status`: show the current session, frame count and errors.
- `uninstall`: remove selected browser host registrations and launcher; recordings and extension files remain. Stop capture first.

Capture options for start/record: `--max-width` (integer 2–3840, default 1280), `--quality` (integer 0–100, default 80), `--out <dir>` and repeatable `--pause-extension <id>`. Durations are 0.001–86400 seconds. `--out` must be a new directory; parents may already exist. Relative CLI paths are resolved before sending. Existing output files are never overwritten.

Frames and metadata remain after stopping. A fatal frame-write error or zero frames releases the session and returns an error. An ffmpeg failure keeps the stopped session: fix the issue and retry `stop -o <different-file>`, or use `discard`. After host loss use `encode` on the retained directory.

## Extension pause configuration

Optional `~/.config/tab-recorder/config.json`:

```json
{"pauseExtensions": ["abcdefghijklmnopabcdefghijklmnop"]}
```

`pauseExtensions` is both the allowlist and the default list. The host rejects CLI `--pause-extension` IDs outside it; add an ID to this config first. Only installed, enabled extensions that permit disabling are paused. Tab Recorder cannot pause itself. Recovery IDs are persisted before disabling. Stopping or worker/browser restart attempts restoration; failed restorations remain pending and missing IDs are discarded. Do not disable/remove Tab Recorder while other extensions are paused.

Pausing extensions reloads the selected tab and can lose page state. It can allow capture when another extension embeds a `chrome-extension://` iframe. The action shows a red `REC` badge during capture; its title identifies the tab and paused extensions.

## Limits and threat model

- Capture is best effort, not guaranteed 60 fps. Unchanged tabs may emit zero frames. Final still duration is retained.
- Debugger permission displays a browser warning. Protected pages, extension iframes or competing DevTools/debugger sessions can prevent attachment. Unexpected detach stops the capture timeline; stop can encode captured frames.
- One browser/native host and one session per OS user. Aside and Chrome share the socket. Close the other browser or disable its Tab Recorder extension before switching.
- The socket directory uses mode 0700 and the socket 0600. Any process running as the same OS user can request recording through the socket. CDP tab capture does not go through macOS Screen Recording permission.
- Native Messaging `allowed_origins` restricts the extension ID allowed to connect; it does not protect against a modified extension using that ID. The host permits pausing only IDs in the config allowlist. No remote API is provided.

Run `node --test`. Real browser capture, extension restoration, worker restart and ffmpeg output require target-machine verification.
