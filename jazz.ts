#!/usr/bin/env bun
// jazz — play a focus video as pixels inside the terminal (Ghostty), looping forever.
// Usage: jazz [file]   (defaults to the batman jazz video)

import { existsSync } from "fs";

const DEFAULT_VIDEO = "/Users/nick/Developer/video-player/batman-jazz.mp4";
const video = process.argv[2] ?? DEFAULT_VIDEO;

if (!existsSync(video)) {
  console.error(`jazz: no such file: ${video}`);
  process.exit(1);
}

// --vo=kitty renders frames via the Kitty graphics protocol, which Ghostty speaks.
// ponytail: if playback stutters at 1080p, add --vo-kitty-use-shm=yes
const mpv = Bun.spawnSync(["mpv", "--vo=kitty", "--loop-file=inf", video], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(mpv.exitCode ?? 1);
