# jazz

A terminal focus-video player, built from the ground up. ffmpeg decodes
contrast-normalized RGB frames while ffplay plays the audio invisibly in the
background; jazz.ts renders the frames into the terminal itself. Loops
forever.

Videos live in ~/.config/jazz. Bare `jazz` plays the only video there, or
brings up an fzf picker when there are several. `jazz <path>` plays any file
outside the library.

`jazz <url>` plays from the web. There is no flag: an argument matching
`https?://` is handed to yt-dlp (`-f b/bv*+ba`, so a muxed stream if one
exists and separate video plus audio otherwise), and everything downstream is
unchanged, because ffmpeg, ffprobe and ffplay open an http URL the same way
they open a file. Seeking is a range request, so nothing is downloaded and
nothing is written to disk. Known ceiling: the resolved links are signed and
expire after a few hours, so a session longer than that would need
re-resolving per respawn.

Three rendering modes:
- `jazz` (default) — real pixels via the Kitty graphics protocol (Ghostty):
  frames are base64-chunked RGB transmitted with a reused image id, scaled by
  the terminal into the pane. Cell pixel size is queried with CSI 16 t.
- `jazz --hd` — quadrant blocks (▘▀▟…), 2x2 pixels per cell: 4x the detail of
  ASCII while still being text.
- `jazz --ascii` — painted ASCII art: brightness picks the character, the
  cell is painted with the pixel's color (dim background, bright glyph).

Controls: space pause/resume, ←/→ seek ±10s, q quit. Resizing the terminal
refits the picture automatically. A dim status line shows state, elapsed/total
time, and the name: the filename for a local file, the yt-dlp title for a URL.

Dependencies: bun, ffmpeg (which provides ffprobe and ffplay). No mpv. yt-dlp
only for URLs. ffmpeg, ffprobe and ffplay are checked up front, before the
picker or the terminal is touched: if any is missing, jazz prints
`jazz: needs <missing> on PATH (brew install ffmpeg)` and exits 1.

Shipped as a standalone compiled binary: `bun run compile` builds jazz.ts
into ~/.bun/bin/jazz (bun runtime embedded — no repo needed to run it).
Re-run after changing jazz.ts; the binary doesn't track the source.

## Where it's headed
- Nothing planned. Possible later: remember position across launches,
  audio-only mode, re-resolving expired URLs — add them when they're actually
  wanted.
- Considered and rejected against tplay (the Rust equivalent, ASCII-only):
  webcam input, subtitles, playback speed. None of them serve a video that
  loops in the corner while you work on something else.
