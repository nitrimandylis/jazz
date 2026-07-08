#!/usr/bin/env bun
// jazz — colored ASCII focus-video player for the terminal.
// ffmpeg decodes the video into raw RGB frames (contrast-normalized so dark
// movie scenes still have detail), we draw each frame as text characters
// colored with the pixel's own RGB via truecolor escapes, and ffplay plays
// the audio invisibly in the background.
//
// Usage: jazz [file]   (defaults to the batman jazz video)
// Keys:  space = pause/resume, q = quit

import { existsSync, appendFileSync } from "fs";
import { basename } from "path";

// Debug instrumentation: JAZZ_LOG=/path/to/file jazz ... writes timing lines.
function debugLog(line: string) {
  if (process.env.JAZZ_LOG) appendFileSync(process.env.JAZZ_LOG, line + "\n");
}

const DEFAULT_VIDEO = "/Users/nick/Developer/video-player/batman-jazz.mp4";
const FPS = 12; // ponytail: fixed frame rate; make it a flag if 12 ever feels wrong
const RAMP = " .,:;i1tfLCG08@"; // darkest → brightest (dense chars read as bright on a dark theme)
const GAMMA = 0.7; // < 1 lifts shadows: dark pixels get real characters, not just dots

// Perceived brightness of an RGB pixel (0-255). Green counts most because
// human eyes are most sensitive to it.
export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Map brightness (0-255) to a character, with a gamma lift for dark scenes.
export function pickChar(lum: number): string {
  const boosted = Math.pow(lum / 255, GAMMA);
  const index = Math.min(RAMP.length - 1, Math.floor(boosted * RAMP.length));
  return RAMP[index];
}

// Turn one raw frame (w*h*3 RGB bytes) into lines of text, each character
// colored with its pixel's RGB, left-padded so the picture sits centered.
export function frameToText(rgb: Uint8Array, w: number, h: number, padLeft: number): string {
  const pad = " ".repeat(padLeft);
  const lines: string[] = [];
  for (let y = 0; y < h; y++) {
    let line = pad;
    let prevColor = "";
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
      const ch = pickChar(luminance(r, g, b));
      if (ch === " ") { // blank cells need no color code
        line += " ";
        continue;
      }
      // Quantize each channel to steps of 8 so runs of similar pixels can
      // share one escape code instead of emitting one per character.
      const color = `\x1b[38;2;${r & ~7};${g & ~7};${b & ~7}m`;
      if (color !== prevColor) {
        line += color;
        prevColor = color;
      }
      line += ch;
    }
    lines.push(line + "\x1b[0m");
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
  const frameSize = w * h * 3; // rgb24: three bytes per pixel
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
      paused = !paused; // the play loop reacts by killing/respawning ffmpeg+ffplay
    }
  });

  // ponytail: terminal resize mid-play isn't handled — quit and relaunch to refit
  let position = 0; // seconds into the video where the current run starts
  while (!quit) { // loop the video forever
    // -re makes ffmpeg decode at playback speed instead of as fast as it can.
    // Without it, Bun buffers the entire decoded stream in memory (gigabytes)
    // and chunk delivery stalls — the player freezes about 12 seconds in.
    decoder = Bun.spawn([
      "ffmpeg", "-v", "error", "-ss", String(position), "-re", "-i", video,
      // normalize stretches each frame's contrast to the full range (smoothed
      // across frames so it doesn't flicker) — dark scenes become readable
      "-vf", `fps=${FPS},scale=${w}:${h},normalize=smoothing=30`,
      "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ], { stdout: "pipe", stderr: "ignore" });

    audio = Bun.spawn(
      ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", "-ss", String(position), video],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );

    // The pacing clock starts at the FIRST frame, not at spawn: ffmpeg takes
    // ~100ms to produce frame one, and with -re it never gets ahead, so a
    // spawn-time clock would mark every frame late and drop them all.
    let start = 0;
    let frames = 0;
    let buf = new Uint8Array(0);

    debugLog(`spawned decoder pid=${decoder.pid} audio pid=${audio.pid} pos=${position} grid=${w}x${h} frameSize=${frameSize}`);
    playthrough: for await (const chunk of decoder.stdout) {
      if (frames === 0) debugLog(`first chunk: ${chunk.length} bytes`);
      if (quit || paused) break;
      const joined = new Uint8Array(buf.length + chunk.length);
      joined.set(buf);
      joined.set(chunk, buf.length);
      buf = joined;

      while (buf.length >= frameSize) {
        if (quit || paused) break playthrough;
        const frame = buf.slice(0, frameSize);
        buf = buf.slice(frameSize);
        if (frames === 0) start = performance.now();

        // Pace frames against the wall clock so video stays in step with the
        // audio. If we fall behind, drop the frame.
        const due = start + frames * frameMs;
        const wait = due - performance.now();
        frames++;
        if (wait > 0) await Bun.sleep(wait);
        else if (wait < -frameMs) continue; // ponytail: drop-to-catch-up is the whole sync strategy

        const text = frameToText(frame, w, h, padLeft);
        process.stdout.write("\x1b[H" + text);
        drawStatus(position + frames / FPS, info.duration, false, cols, totalRows, basename(video));
        if (frames % FPS === 0) {
          debugLog(`t=${Math.round(performance.now() - start)}ms frames=${frames} late=${Math.round(-wait)}ms textBytes=${text.length} buf=${buf.length} rss=${Math.round(process.memoryUsage.rss() / 1e6)}MB`);
        }
      }
    }

    debugLog(`playthrough ended: frames=${frames} quit=${quit} paused=${paused}`);
    // Stop both processes: a paused -re decoder would otherwise keep piling
    // frames into Bun's pipe buffer for as long as the pause lasts.
    decoder.kill();
    audio.kill();

    if (paused && !quit) {
      position += frames / FPS; // resume respawns both from here via -ss
      drawStatus(position, info.duration, true, cols, totalRows, basename(video));
      while (paused && !quit) await Bun.sleep(50);
    } else if (!quit) {
      position = 0; // natural end of the file: loop from the top
    }
  }

  cleanup();
  process.exit(0);
}

if (import.meta.main) {
  main();
}
