---
name: jazz-cli
description: Drive the jazz CLI — a terminal focus-video player that renders video into Ghostty via the Kitty graphics protocol, plays local files or any yt-dlp URL, and loops forever. Use whenever the user wants a video or focus loop playing in their terminal, mentions jazz, asks about the ~/.config/jazz library, wants to add a video to it, or is debugging jazz playback, sync, or rendering modes.
---

# jazz

`jazz` plays a video inside the terminal while the user works. ffmpeg decodes at playback speed, ffplay
handles audio invisibly, and one TypeScript file turns frames into something Ghostty can draw. It loops
forever. Compiled Bun binary at `~/.bun/bin/jazz`. Full offline reference: `man jazz`.

## You cannot run this from a tool call

`jazz` puts stdin into raw mode as soon as it has a source to play. Without a real TTY it dies with
`process.stdin.setRawMode is not a function`. **Do not spawn it to play anything, and do not read that
crash as a bug in jazz.**

`jazz --help` is the one exception and is safe from a tool call: help is handled before the terminal
is touched. Everything else needs a human at the keyboard. Read `man jazz` for the full reference.

**There is no `--json` and no headless read of any kind.** jazz is a player; it has no status, no
library listing, and nothing to serialise. If a caller needs to know what is in the library, read
`~/.config/jazz` directly.

Everything below is a command to hand the user, or a file to edit on their behalf.

## Commands

```bash
jazz                      # the library: plays the only file in ~/.config/jazz, or opens an fzf picker
jazz ~/Movies/heat.mkv    # any local file
jazz https://youtu.be/…   # any URL yt-dlp knows; nothing downloads
jazz --hd <source>        # 2×2 quadrant glyphs
jazz --ascii <source>     # painted 15-step ramp
```

Default mode transmits real pixels over the Kitty graphics protocol. `--hd` and `--ascii` are lower
fidelity tiers that compose with files and URLs alike.

Keys once running: space pauses, ←/→ seek ±10s and stack, `q` quits. Every one is implemented as "kill
ffmpeg, respawn at a timestamp", which is also how resize works.

## The library

Videos live in `~/.config/jazz/`, not in the repo. Adding one is a file move:

```bash
mv ~/Downloads/focus-loop.mp4 ~/.config/jazz/
```

One file means bare `jazz` plays it. More than one opens an fzf picker, so `fzf` becomes a dependency
the moment the library grows.

## Things that will bite you

- **Needs ffmpeg on PATH** (`brew install ffmpeg`, which brings ffprobe and ffplay), plus `yt-dlp` for
  URLs and `fzf` for a multi-file library. Default pixel mode needs a Kitty-graphics terminal — Ghostty,
  kitty, or WezTerm. In anything else, `--hd` or `--ascii`.
- **Resolved URLs are signed and expire in a few hours.** yt-dlp hands back a direct stream link that
  ffmpeg opens like a file, which is why seeking is a free HTTP range request — and why a link that
  worked this morning is dead this evening. Re-run the command, don't debug the player.
- **Late frames are dropped, deliberately.** Anything more than one frame behind the first-frame wall
  clock is discarded so audio never waits for video. Stutter on a heavy file is the sync strategy
  working, not a failure.
- **The binary is a snapshot, not a symlink.** It embeds the Bun runtime, so the repo can disappear and
  `jazz` keeps working — and editing `jazz.ts` changes nothing until `bun run compile` runs again.
- **`JAZZ_LOG=/tmp/j.log jazz` is the debug tap**, printing per-second frame count, lateness, buffer and
  rss. Ask for that file before theorising about a playback problem.
