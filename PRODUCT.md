# jazz

A terminal focus-video player, built from the ground up. ffmpeg decodes
contrast-normalized RGB frames while ffplay plays the audio invisibly in the
background; jazz.ts renders the frames into the terminal itself. Loops
forever. `jazz <file>` plays any other video the same way.

Three rendering modes:
- `jazz` (default) — real pixels via the Kitty graphics protocol (Ghostty):
  frames are base64-chunked RGB transmitted with a reused image id, scaled by
  the terminal into the pane. Cell pixel size is queried with CSI 16 t.
- `jazz --hd` — quadrant blocks (▘▀▟…), 2x2 pixels per cell: 4x the detail of
  ASCII while still being text.
- `jazz --ascii` — painted ASCII art: brightness picks the character, the
  cell is painted with the pixel's color (dim background, bright glyph).

Controls: space pause/resume, ←/→ seek ±10s, q quit. Resizing the terminal
refits the picture automatically. A dim status line shows state, file, and
elapsed/total time.

Dependencies: bun, ffmpeg (which provides ffprobe and ffplay). No mpv.

## Where it's headed
- Nothing planned. Possible later: remember position across launches,
  audio-only mode — add them when they're actually wanted.
