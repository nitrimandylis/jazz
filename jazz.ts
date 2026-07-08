#!/usr/bin/env bun
// jazz — ASCII focus-video player for the terminal.
// ffmpeg decodes the video into raw grayscale frames, we draw each frame as
// text characters (no colors, so it always matches the terminal theme), and
// ffplay plays the audio invisibly in the background.
//
// Usage: jazz [file]   (defaults to the batman jazz video)
// Keys:  space = pause/resume, q = quit

import { existsSync } from "fs";
import { basename } from "path";

const DEFAULT_VIDEO = "/Users/nick/Developer/video-player/batman-jazz.mp4";
const FPS = 12; // ponytail: fixed frame rate; make it a flag if 12 ever feels wrong
const RAMP = " .:-=+*#%@"; // darkest → brightest (dense chars read as bright on a dark theme)

// Map one grayscale pixel (0-255) to one character.
export function pickChar(luminance: number): string {
  const index = Math.floor((luminance / 255) * (RAMP.length - 1));
  return RAMP[index];
}

// Turn one raw frame (w*h grayscale bytes) into lines of text,
// left-padded so the picture sits centered in the terminal.
export function frameToText(bytes: Uint8Array, w: number, h: number, padLeft: number): string {
  const pad = " ".repeat(padLeft);
  const lines: string[] = [];
  for (let y = 0; y < h; y++) {
    let line = pad;
    for (let x = 0; x < w; x++) {
      line += pickChar(bytes[y * w + x]);
    }
    lines.push(line);
  }
  return lines.join("\n");
}

// Work out how many character cells the video should occupy.
// A terminal cell is roughly twice as tall as it is wide, so one row of
// characters counts as two pixels of height when preserving aspect ratio.
export function fitToTerminal(videoW: number, videoH: number, cols: number, rows: number) {
  const aspect = videoW / videoH;
  let w = cols;
  let h = Math.round(w / aspect / 2);
  if (h > rows) {
    h = rows;
    w = Math.round(h * 2 * aspect);
  }
  const padLeft = Math.floor((cols - w) / 2);
  return { w, h, padLeft };
}

export function fmtTime(totalSeconds: number): string {
  const s = Math.floor(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const mm = String(m).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Ask ffprobe for the video's size and duration.
function probe(file: string): { width: number; height: number; duration: number } {
  const p = Bun.spawnSync([
    "ffprobe", "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-show_entries", "format=duration",
    "-of", "csv=p=0", file,
  ]);
  let width = 0, height = 0, duration = 0;
  for (const line of p.stdout.toString().trim().split("\n")) {
    if (line.includes(",")) {
      const [w, h] = line.split(",");
      width = parseInt(w);
      height = parseInt(h);
    } else {
      duration = parseFloat(line);
    }
  }
  if (!width || !height) {
    console.error(`jazz: ffprobe could not read ${file}`);
    process.exit(1);
  }
  return { width, height, duration };
}

function drawStatus(elapsed: number, duration: number, paused: boolean, cols: number, row: number, name: string) {
  const left = ` ${paused ? "paused" : "playing"} · ${name}`;
  const right = `${fmtTime(elapsed)} / ${fmtTime(duration)} · space pause · q quit `;
  const gap = Math.max(1, cols - left.length - right.length);
  const line = (left + " ".repeat(gap) + right).slice(0, cols);
  // \x1b[2m = dim, still the theme's own foreground color
  process.stdout.write(`\x1b[${row};1H\x1b[2m${line}\x1b[0m`);
}

async function main() {
  const video = process.argv[2] ?? DEFAULT_VIDEO;
  if (!existsSync(video)) {
    console.error(`jazz: no such file: ${video}`);
    process.exit(1);
  }

  const info = probe(video);
  const cols = process.stdout.columns ?? 80;
  const totalRows = process.stdout.rows ?? 24;
  const videoRows = totalRows - 1; // bottom row is the status line
  const { w, h, padLeft } = fitToTerminal(info.width, info.height, cols, videoRows);
  const frameSize = w * h;
  const frameMs = 1000 / FPS;

  // Enter the alternate screen, clear it, hide the cursor.
  process.stdout.write("\x1b[?1049h\x1b[2J\x1b[?25l");
  process.stdin.setRawMode(true);
  process.stdin.resume();

  let paused = false;
  let quit = false;
  let decoder: ReturnType<typeof Bun.spawn> | null = null;
  let audio: ReturnType<typeof Bun.spawn> | null = null;

  function cleanup() {
    try { process.stdin.setRawMode(false); } catch {}
    process.stdout.write("\x1b[?25h\x1b[?1049l"); // show cursor, leave alternate screen
    decoder?.kill();
    audio?.kill();
  }
  process.on("exit", cleanup);

  process.stdin.on("data", (key: Buffer) => {
    const k = key.toString();
    if (k === "q" || k === "\x03") { // q or ctrl-c
      quit = true;
      decoder?.kill();
      audio?.kill();
    } else if (k === " ") {
      paused = !paused;
      if (audio) process.kill(audio.pid, paused ? "SIGSTOP" : "SIGCONT");
    }
  });

  // ponytail: terminal resize mid-play isn't handled — quit and relaunch to refit
  while (!quit) { // loop the video forever
    decoder = Bun.spawn([
      "ffmpeg", "-v", "error", "-i", video,
      "-vf", `fps=${FPS},scale=${w}:${h}`,
      "-f", "rawvideo", "-pix_fmt", "gray", "-",
    ], { stdout: "pipe", stderr: "ignore" });

    audio = Bun.spawn(
      ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", video],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );

    const start = performance.now();
    let pausedMs = 0;
    let frames = 0;
    let buf = new Uint8Array(0);

    for await (const chunk of decoder.stdout) {
      if (quit) break;
      const joined = new Uint8Array(buf.length + chunk.length);
      joined.set(buf);
      joined.set(chunk, buf.length);
      buf = joined;

      while (buf.length >= frameSize && !quit) {
        const frame = buf.slice(0, frameSize);
        buf = buf.slice(frameSize);

        if (paused) {
          const pauseStart = performance.now();
          drawStatus(frames / FPS, info.duration, true, cols, totalRows, basename(video));
          while (paused && !quit) await Bun.sleep(50);
          pausedMs += performance.now() - pauseStart;
        }

        // Pace frames against the wall clock (minus paused time) so video
        // stays in step with the audio. If we fall behind, drop the frame.
        const due = start + pausedMs + frames * frameMs;
        const wait = due - performance.now();
        frames++;
        if (wait > 0) await Bun.sleep(wait);
        else if (wait < -frameMs) continue; // ponytail: drop-to-catch-up is the whole sync strategy

        process.stdout.write("\x1b[H" + frameToText(frame, w, h, padLeft));
        drawStatus(frames / FPS, info.duration, false, cols, totalRows, basename(video));
      }
    }
    audio.kill(); // playthrough finished (or quit): stop audio before looping
  }

  cleanup();
  process.exit(0);
}

if (import.meta.main) {
  main();
}
