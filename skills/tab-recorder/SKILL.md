---
name: tab-recorder
description: Record an Aside or Google Chrome tab to MP4 from the shell with the tab-recorder CLI, including background tabs and several tabs in parallel. Use when asked to record a web page, make a demo or PR evidence video of a browser flow, or check how smoothly a page plays. Do not use when the recording must show anything outside one tab (native apps, OS dialogs, several apps); use a screen recorder for that.
---

# tab-recorder

tab-recorder captures one tab through CDP screencast and writes an MP4. It needs no clicks or keyboard focus, so run it directly from the shell. It does not go through any GUI queue. No audio is captured.

## Before recording

1. `tab-recorder status` must return JSON. An error about the socket or host means the browser is closed or the extension is not loaded. Stop and report it. Do not run `install` or `uninstall` yourself.
2. `tab-recorder tabs` lists tab IDs, titles and URLs. Pass a numeric ID to `--tab`. Avoid `--tab active` because the active tab changes when someone else switches tabs. A URL substring works only when it matches exactly one tab.
3. The tab must be painting. A tab that is not visible in any window emits no frames. Tabs opened by an `aside exec` task that has finished often stop painting. Keep the tab active in its window, or hold it open with an `aside repl` session for the length of the recording.
4. Do not record tabs showing meetings, mail or chat unless the user asked for that tab. The video contains everything the tab shows.

## Fixed-length recording

```sh
tab-recorder record --tab 123 --duration 15 -o /abs/path/demo.mp4
```

`record` blocks until the MP4 is written. Run recordings longer than about a minute in the background. Killing the command stops the capture and still encodes what was captured.

## Recording while the page is operated

```sh
tab-recorder start --tab 123 --out /abs/path/frames-demo --max-duration 600
# operate the page, e.g. with `aside exec`
tab-recorder stop --session <id> -o /abs/path/demo.mp4
```

- Always pass `--max-duration` to `start` so a forgotten session stops itself.
- Start the recording before you set up page state. If extensions are configured to pause, starting reloads the tab and the state is lost.
- Use `discard --session <id>` to drop a session without encoding.

## Several tabs at once

- Up to 4 sessions can run at the same time, one per tab. Recording the same tab twice is rejected.
- Start each `record` as its own background command. A `record` that ends or is killed stops only its own session.
- Always pass `--session <id>` to `stop` and `discard`, even when only one session is active. Without it, the command acts on whatever single session exists, which may belong to another agent. With two or more sessions active, the flag is required. `status` lists every session.

## Paths

- `-o` must name a file that does not exist yet. `--out` must name a directory that does not exist yet. Nothing is overwritten.
- Use absolute paths, or paths relative to the shell's current directory.
- Frames stay in the frames directory after stopping. Delete it once the MP4 is checked if the user does not need it.

## Checking the result

```sh
ffprobe -v error -show_entries format=duration -of csv=p=0 /abs/path/demo.mp4
```

Count frames with `ffprobe -v error -count_frames -select_streams v -show_entries stream=nb_read_frames -of csv=p=0 <file>`. Report the path, duration and frame count. A page that does not repaint emits few frames. That is expected and the last frame is held until the end.

## When it fails

- Attach fails on a page where another extension injects a `chrome-extension://` iframe. Extensions listed in `~/.config/tab-recorder/config.json` are paused during recording to avoid this. Do not edit that file. Report the error message to the user. The error does not name the blocking extension.
- Zero frames (`No frames received`): the tab never painted. Make it visible as described in "Before recording", then record again.
- ffmpeg failed: the error names the session ID. Run `stop --session <id> -o <new file>` again, or `tab-recorder encode <frames dir> -o <new file>`.
- A stale session blocks a tab: check `status`, then `stop` or `discard` it only if you started it.
