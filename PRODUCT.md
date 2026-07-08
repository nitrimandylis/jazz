# jazz

A terminal focus-video player. `jazz` plays the batman jazz video as actual
pixels inside a Ghostty pane (via mpv's Kitty graphics protocol output),
looping forever, so the movie vibes along while you work. `jazz <file>` plays
any other video the same way.

It is deliberately a thin wrapper: mpv does decoding, audio, A/V sync, and
in-player controls (space pause, arrows seek, 9/0 volume, q quit). This tool
is the launcher with the right flags baked in.

## Where it's headed
- Nothing planned. Possible later: audio-only flag, resume-position, a videos
  library — add them when they're actually wanted.
