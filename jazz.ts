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

// Turn one raw frame (w*h*3 RGB bytes) into lines of text. Each cell is
// "painted": background = the pixel dimmed, glyph = the pixel brightened,
// so the full cell shows color while the ASCII texture stays readable.
// Lines are left-padded so the picture sits centered.
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
      // Quantize channels to steps of 16 so runs of similar pixels share one
      // escape code instead of emitting ~38 bytes per character.
      const fr = Math.min(255, Math.round(r * 1.25) + 24) & ~15; // glyph: brightened
      const fg = Math.min(255, Math.round(g * 1.25) + 24) & ~15;
      const fb = Math.min(255, Math.round(b * 1.25) + 24) & ~15;
      const br = Math.round(r * 0.4) & ~15; // background: dimmed
      const bg = Math.round(g * 0.4) & ~15;
      const bb = Math.round(b * 0.4) & ~15;
      const color = `\x1b[38;2;${fr};${fg};${fb};48;2;${br};${bg};${bb}m`;
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

// --hd mode: each cell holds two vertically stacked pixels (a ▀ block with
// separate top/bottom colors), so the pixel grid is cols wide and 2*rows
// tall, and each pixel is roughly square.
export function fitPixelsToTerminal(videoW: number, videoH: number, cols: number, rows: number) {
  const aspect = videoW / videoH;
  let w = cols;
  let h = Math.round(w / aspect);
  if (h > rows * 2) {
    h = rows * 2;
    w = Math.round(h * aspect);
  }
  w = Math.max(1, Math.min(cols, w));
  h = Math.max(2, 2 * Math.floor(h / 2)); // two pixels per cell: keep h even
  const padLeft = Math.max(0, Math.floor((cols - w) / 2));
  return { w, h, padLeft };
}

// Render a frame as half-block "pixels": one ▀ per cell, foreground colors
// the top pixel and background colors the bottom pixel.
export function frameToHalfBlocks(rgb: Uint8Array, w: number, h: number, padLeft: number): string {
  const pad = " ".repeat(padLeft);
  const lines: string[] = [];
  for (let cy = 0; cy < h / 2; cy++) {
    let line = pad;
    let prevColor = "";
    for (let x = 0; x < w; x++) {
      const t = (cy * 2 * w + x) * 3; // top pixel
      const b = ((cy * 2 + 1) * w + x) * 3; // bottom pixel
      const color =
        `\x1b[38;2;${rgb[t] & ~7};${rgb[t + 1] & ~7};${rgb[t + 2] & ~7};` +
        `48;2;${rgb[b] & ~7};${rgb[b + 1] & ~7};${rgb[b + 2] & ~7}m`;
      if (color !== prevColor) {
        line += color;
        prevColor = color;
      }
      line += "▀"; // ▀
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
  w = Math.max(1, w); // a degenerate terminal size must never produce a 0- or
  h = Math.max(1, h); // negative-sized grid — that corrupts frame slicing
  const padLeft = Math.max(0, Math.floor((cols - w) / 2));
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
  const right = `${fmtTime(elapsed)} / ${fmtTime(duration)} · space pause · ←→ seek · q quit `;
  const gap = Math.max(1, cols - left.length - right.length);
  const line = (left + " ".repeat(gap) + right).slice(0, cols);
  // \x1b[2m = dim, still the theme's own foreground color
  process.stdout.write(`\x1b[${row};1H\x1b[2m${line}\x1b[0m`);
}

async function main() {
  const hd = process.argv.includes("--hd"); // half-block pixels, 2x vertical detail
  const video = process.argv.slice(2).find((a) => a !== "--hd") ?? DEFAULT_VIDEO;
  if (!existsSync(video)) {
    console.error(`jazz: no such file: ${video}`);
    process.exit(1);
  }

  const info = probe(video);
  const frameMs = 1000 / FPS;

  // Enter the alternate screen, clear it, hide the cursor.
  process.stdout.write("\x1b[?1049h\x1b[2J\x1b[?25l");
  process.stdin.setRawMode(true);
  process.stdin.resume();

  let paused = false;
  let quit = false;
  let seek = 0; // seconds of pending arrow-key seeks, applied at next respawn
  let resized = false;
  let decoder: ReturnType<typeof Bun.spawn> | null = null;
  let audio: ReturnType<typeof Bun.spawn> | null = null;

  function cleanup() {
    try { process.stdin.setRawMode(false); } catch {}
    process.stdout.write("\x1b[?25h\x1b[?1049l"); // show cursor, leave alternate screen
    decoder?.kill();
    audio?.kill();
  }
  process.on("exit", cleanup);

  // Scan the chunk character by character: fast keypresses (and escape
  // sequences like arrows) can arrive coalesced into one data event.
  process.stdin.on("data", (key: Buffer) => {
    const s = key.toString();
    debugLog(`key: ${JSON.stringify(s)}`);
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "q" || s[i] === "\x03") { // q or ctrl-c
        quit = true;
        decoder?.kill();
        audio?.kill();
      } else if (s[i] === " ") {
        paused = !paused; // the play loop reacts by killing/respawning ffmpeg+ffplay
        if (paused) decoder?.kill();
      } else if (s.startsWith("\x1b[C", i)) { // right arrow: forward 10s
        seek += 10;
        decoder?.kill();
        i += 2;
      } else if (s.startsWith("\x1b[D", i)) { // left arrow: back 10s
        seek -= 10;
        decoder?.kill();
        i += 2;
      }
    }
  });

  process.on("SIGWINCH", () => { // terminal was resized: refit and continue
    resized = true;
    decoder?.kill();
  });

  let position = 0; // seconds into the video where the current run starts
  let cols = 80;
  let totalRows = 24;
  while (!quit) { // loop the video forever
    if (paused) {
      drawStatus(position, info.duration, true, cols, totalRows, basename(video));
      while (paused && !quit) await Bun.sleep(50);
      if (quit) break;
    }

    // Re-measure the terminal on every (re)start so resizes take effect.
    // || not ??: some ptys report 0x0, which must also fall back.
    cols = process.stdout.columns || 80;
    totalRows = process.stdout.rows || 24;
    const { w, h, padLeft } = hd
      ? fitPixelsToTerminal(info.width, info.height, cols, totalRows - 1)
      : fitToTerminal(info.width, info.height, cols, totalRows - 1);
    const frameSize = w * h * 3; // rgb24: three bytes per pixel
    if (resized) {
      resized = false;
      process.stdout.write("\x1b[2J"); // the old frame may stick out of the new grid
    }

    // Apply pending arrow-key seeks, staying inside the video.
    if (seek !== 0) {
      position = Math.max(0, Math.min(position + seek, Math.max(0, info.duration - 1)));
      seek = 0;
    }

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

        const text = hd
          ? frameToHalfBlocks(frame, w, h, padLeft)
          : frameToText(frame, w, h, padLeft);
        process.stdout.write("\x1b[H" + text);
        drawStatus(position + frames / FPS, info.duration, false, cols, totalRows, basename(video));
        if (frames % FPS === 0) {
          debugLog(`t=${Math.round(performance.now() - start)}ms frames=${frames} late=${Math.round(-wait)}ms textBytes=${text.length} buf=${buf.length} rss=${Math.round(process.memoryUsage.rss() / 1e6)}MB`);
        }
      }
    }

    debugLog(`playthrough ended: frames=${frames} quit=${quit} paused=${paused} seek=${seek} resized=${resized}`);
    // Stop both processes: a paused -re decoder would otherwise keep piling
    // frames into Bun's pipe buffer for as long as the pause lasts.
    decoder.kill();
    audio.kill();

    if (!paused && seek === 0 && !resized) {
      position = 0; // natural end of the file: loop from the top
    } else {
      position += frames / FPS; // pause/seek/resize: continue from where we stopped
    }
  }

  cleanup();
  process.exit(0);
}

if (import.meta.main) {
  main();
}
