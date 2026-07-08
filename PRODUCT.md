# jazz

A terminal focus-video player, built from the ground up. `jazz` plays the
batman jazz video as colored ASCII art inside the terminal: ffmpeg decodes
contrast-normalized RGB frames (so dark movie scenes stay readable), jazz.ts
maps each pixel's brightness to a character and paints it with the pixel's
own color via truecolor escapes, while ffplay plays the audio invisibly in
the background. Loops forever. `jazz <file>` plays any other video the same
way. Resolution equals the terminal grid: shrink the font (cmd+minus in
Ghostty) before launching for a sharper picture.

Controls: space pause/resume, q quit. A dim status line shows state, file,
and elapsed/total time.

Dependencies: bun, ffmpeg (which provides ffprobe and ffplay). No mpv.

## Where it's headed
- Nothing planned. Possible later: seek keys, resize handling, audio-only
  mode, color ASCII — add them when they're actually wanted.
