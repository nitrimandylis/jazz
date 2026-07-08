# jazz

A terminal focus-video player, built from the ground up. `jazz` plays the
batman jazz video as ASCII art inside the terminal: ffmpeg decodes frames,
jazz.ts maps each pixel's brightness to a character (` .:-=+*#%@`) drawn in
the terminal's own foreground color — so the picture always matches the
terminal theme — while ffplay plays the audio invisibly in the background.
Loops forever. `jazz <file>` plays any other video the same way.

Controls: space pause/resume, q quit. A dim status line shows state, file,
and elapsed/total time.

Dependencies: bun, ffmpeg (which provides ffprobe and ffplay). No mpv.

## Where it's headed
- Nothing planned. Possible later: seek keys, resize handling, audio-only
  mode, color ASCII — add them when they're actually wanted.
