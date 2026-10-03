#!/usr/bin/env bun
// jazz — focus-video player for the terminal.
// ffmpeg decodes the video into raw RGB frames (contrast-normalized so dark
// movie scenes still have detail) and ffplay plays the audio invisibly in
// the background. Frames render as real pixels (Kitty graphics protocol) by
// default, quadrant blocks with --hd, or painted ASCII with --ascii.
//
// Usage: jazz [--hd|--ascii] [file|url]
//        With no file: plays from ~/.config/jazz (fzf picker if several).
//        A URL is resolved to a direct stream by yt-dlp first.
// Keys:  space = pause/resume, ←/→ = seek ±10s, q = quit

import { existsSync, appendFileSync, readdirSync, mkdirSync } from "fs";
import { basename } from "path";
import { homedir } from "os";

// Debug instrumentation: JAZZ_LOG=/path/to/file jazz ... writes timing lines.
function debugLog(line: string) {
  if (process.env.JAZZ_LOG) appendFileSync(process.env.JAZZ_LOG, line + "\n");
}

const LIBRARY = `${homedir()}/.config/jazz`; // where the focus videos live

const HELP = `jazz — focus-video player for the terminal

Usage:
  jazz                 play from ~/.config/jazz (fzf picker if there are several)
  jazz <file>          play a local video
  jazz <url>           play any yt-dlp-supported URL
  jazz --hd            render as quadrant blocks instead of real pixels
  jazz --ascii         render as painted ASCII
  jazz -h, --help      this

Keys:  space pause/resume · ←/→ seek ±10s · q quit

Needs ffmpeg, ffprobe and ffplay on PATH (checked up front; exits 1 with
brew install ffmpeg if any is missing), plus yt-dlp for URLs. Real-pixel rendering
needs a terminal speaking the Kitty graphics protocol (Ghostty, kitty,
WezTerm); use --hd or --ascii anywhere else.

jazz has no machine-readable mode: it is a full-screen player that puts the
terminal into raw mode at startup, so there is nothing for --json to print.
`;
const VIDEO_EXTS = [".mp4", ".mkv", ".mov", ".webm", ".m4v"];
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

// --hd mode: each cell holds a 2x2 block of pixels rendered as a quadrant
// character (▘▀▐▟…) with two colors: bright pixels average into the
// foreground, dark ones into the background.
const QUAD = [" ", "▘", "▝", "▀", "▖", "▌", "▞", "▛", "▗", "▚", "▐", "▜", "▄", "▙", "▟", "█"];

export function frameToQuadrants(rgb: Uint8Array, pw: number, ph: number, padLeft: number): string {
  const pad = " ".repeat(padLeft);
  const lines: string[] = [];
  for (let cy = 0; cy < ph / 2; cy++) {
    let line = pad;
    let prevColor = "";
    for (let cx = 0; cx < pw / 2; cx++) {
      // the cell's four pixels: top-left, top-right, bottom-left, bottom-right
      const idx = [
        (cy * 2 * pw + cx * 2) * 3,
        (cy * 2 * pw + cx * 2 + 1) * 3,
        ((cy * 2 + 1) * pw + cx * 2) * 3,
        ((cy * 2 + 1) * pw + cx * 2 + 1) * 3,
      ];
      const lums = idx.map((i) => luminance(rgb[i], rgb[i + 1], rgb[i + 2]));
      const avg = (lums[0] + lums[1] + lums[2] + lums[3]) / 4;
      let bits = 0;
      for (let p = 0; p < 4; p++) if (lums[p] > avg) bits |= 1 << p;
      // average bright pixels into the glyph color, dark into the background
      let fr = 0, fg = 0, fb = 0, fn = 0;
      let br = 0, bg = 0, bb = 0, bn = 0;
      for (let p = 0; p < 4; p++) {
        const i = idx[p];
        if (bits & (1 << p)) { fr += rgb[i]; fg += rgb[i + 1]; fb += rgb[i + 2]; fn++; }
        else { br += rgb[i]; bg += rgb[i + 1]; bb += rgb[i + 2]; bn++; }
      }
      const q = (sum: number, n: number) => (n ? Math.round(sum / n) & ~7 : 0);
      const color = `\x1b[38;2;${q(fr, fn)};${q(fg, fn)};${q(fb, fn)};48;2;${q(br, bn)};${q(bg, bn)};${q(bb, bn)}m`;
      if (color !== prevColor) {
        line += color;
        prevColor = color;
      }
      line += QUAD[bits];
    }
    lines.push(line + "\x1b[0m");
  }
  return lines.join("\n");
}

// Default mode: real pixels via the Kitty graphics protocol (Ghostty speaks
// it). One frame = the raw RGB bytes base64-encoded and sent in <=4096-byte
// chunks, as the spec requires. Re-using image id 1 every frame makes the
// terminal replace the previous frame in place. C=1 keeps the cursor put.
export function kittyFrame(rgb: Uint8Array, w: number, h: number, c: number, r: number): string {
  const b64 = Buffer.from(rgb).toString("base64");
  const parts: string[] = [];
  for (let i = 0; i < b64.length; i += 4096) {
    const chunk = b64.slice(i, i + 4096);
    const m = i + 4096 >= b64.length ? 0 : 1;
    if (i === 0) {
      parts.push(`\x1b_Ga=T,f=24,i=1,q=2,C=1,s=${w},v=${h},c=${c},r=${r},m=${m};${chunk}\x1b\\`);
    } else {
      parts.push(`\x1b_Gm=${m};${chunk}\x1b\\`);
    }
  }
  return parts.join("");
}

// Fit the video into the terminal's pixel area. w/h is the transmitted image
// size; c/r is the cell rectangle the terminal scales it into.
export function fitGraphics(videoW: number, videoH: number, cols: number, rows: number, cellW: number, cellH: number) {
  const aspect = videoW / videoH;
  let w = cols * cellW;
  let h = Math.round(w / aspect);
  if (h > rows * cellH) {
    h = rows * cellH;
    w = Math.round(h * aspect);
  }
  w = Math.max(1, w);
  h = Math.max(1, h);
  const c = Math.max(1, Math.min(cols, Math.ceil(w / cellW)));
  const r = Math.max(1, Math.min(rows, Math.ceil(h / cellH)));
  // ponytail: cap the transmitted width to bound escape-stream throughput;
  // the terminal scales it up to the c/r rect. Lower the cap if it stutters.
  if (w > 1280) {
    h = Math.max(1, Math.round(h * (1280 / w)));
    w = 1280;
  }
  const padLeft = Math.max(0, Math.floor((cols - c) / 2));
  return { w, h, c, r, padLeft };
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

// yt-dlp printed the title, then one URL per selected format. Muxed formats
// give a single URL; separate video+audio give two, in that order.
export function parseYtdlp(stdout: string): { title: string; video: string; audio: string } {
  const lines = stdout.trim().split("\n").filter((l) => l.length > 0);
  const urls = lines.filter((l) => l.startsWith("http"));
  const title = lines.find((l) => !l.startsWith("http")) ?? "stream";
  return { title, video: urls[0], audio: urls[1] ?? urls[0] };
}

// Turn a page URL into direct stream URLs. ffmpeg, ffprobe and ffplay all open
// an http URL exactly like a file, so nothing downstream changes — seeking
// still works, over range requests instead of disk.
function resolveUrl(url: string): { title: string; video: string; audio: string } {
  if (!Bun.which("yt-dlp")) {
    console.error("jazz: playing a URL needs yt-dlp (brew install yt-dlp)");
    process.exit(1);
  }
  // b/bv*+ba: prefer one muxed stream, fall back to separate video and audio.
  const p = Bun.spawnSync(["yt-dlp", "-f", "b/bv*+ba", "--print", "%(title)s", "--print", "urls", url]);
  const out = parseYtdlp(p.stdout.toString());
  if (p.exitCode !== 0 || !out.video) {
    console.error(`jazz: yt-dlp could not resolve ${url}\n${p.stderr.toString().trim()}`);
    process.exit(1);
  }
  // ponytail: resolved once at startup. Signed URLs expire after a few hours,
  // so a very long session eventually 403s — re-resolve per respawn if it bites.
  return out;
}

function drawStatus(elapsed: number, duration: number, paused: boolean, cols: number, row: number, name: string) {
  const left = ` ${paused ? "paused" : "playing"} · ${name}`;
  const right = `${fmtTime(elapsed)} / ${fmtTime(duration)} · space pause · ←→ seek · q quit `;
  const gap = Math.max(1, cols - left.length - right.length);
  const line = (left + " ".repeat(gap) + right).slice(0, cols);
  // \x1b[2m = dim, still the theme's own foreground color
  process.stdout.write(`\x1b[${row};1H\x1b[2m${line}\x1b[0m`);
}

// Ask the terminal for its cell size in pixels (CSI 16 t, answered by
// Ghostty). Falls back to a 2:1 guess if there's no reply within 250ms.
async function queryCellSize(): Promise<{ width: number; height: number }> {
  return await new Promise((resolve) => {
    const timer = setTimeout(() => done({ width: 8, height: 16 }), 250);
    function onData(chunk: Buffer) {
      const m = chunk.toString().match(/\x1b\[6;(\d+);(\d+)t/);
      if (m) done({ height: parseInt(m[1]), width: parseInt(m[2]) });
    }
    function done(size: { width: number; height: number }) {
      clearTimeout(timer);
      process.stdin.off("data", onData);
      resolve(size);
    }
    process.stdin.on("data", onData);
    process.stdout.write("\x1b[16t");
  });
}

// No path given: play from ~/.config/jazz. One video plays directly;
// several bring up an fzf picker.
function pickFromLibrary(): string {
  mkdirSync(LIBRARY, { recursive: true });
  const videos = readdirSync(LIBRARY)
    .filter((f) => VIDEO_EXTS.some((ext) => f.toLowerCase().endsWith(ext)))
    .sort();
  if (videos.length === 0) {
    console.error(`jazz: no videos in ${LIBRARY} — drop some there, or pass a path`);
    process.exit(1);
  }
  if (videos.length === 1) return `${LIBRARY}/${videos[0]}`;
  if (!Bun.which("fzf")) {
    console.error(`jazz: several videos in ${LIBRARY} but fzf isn't installed (brew install fzf)`);
    process.exit(1);
  }
  // no --height: fzf's inline mode needs a cursor-position reply some
  // environments never send; fullscreen works everywhere
  const fzf = Bun.spawnSync(["fzf", "--prompt", "jazz> ", "--reverse"], {
    stdin: Buffer.from(videos.join("\n")),
    stdout: "pipe",
    stderr: "inherit",
  });
  const choice = fzf.stdout.toString().trim();
  debugLog(`fzf: exit=${fzf.exitCode} choice=${JSON.stringify(choice)}`);
  if (!choice) process.exit(0); // picker cancelled
  return `${LIBRARY}/${choice}`;
}

async function main() {
  const args = process.argv.slice(2);
  // Help has to come first: everything below either opens an fzf picker or
  // takes over the terminal, so `jazz --help` used to hang instead of printing.
  if (args.includes("-h") || args.includes("--help")) return void console.log(HELP);

  // ffmpeg is not optional and was not checked: a machine without it got a raw
  // Bun "Executable not found in $PATH" trace out of probe(), which reads as
  // jazz being broken rather than as a missing install. Check all three up
  // front, before the picker and before the terminal is taken over.
  const missing = ["ffmpeg", "ffprobe", "ffplay"].filter((b) => !Bun.which(b));
  if (missing.length > 0) {
    console.error(`jazz: needs ${missing.join(", ")} on PATH (brew install ffmpeg)`);
    process.exit(1);
  }

  // rendering mode: real pixels by default, --ascii for painted text art,
  // --hd for quadrant blocks (2x2 pixels per cell)
  const mode = args.includes("--ascii") ? "ascii" : args.includes("--hd") ? "hd" : "pixels";
  const source = args.find((a) => !a.startsWith("--")) ?? pickFromLibrary();
  const isUrl = /^https?:\/\//.test(source);
  if (!isUrl && !existsSync(source)) {
    console.error(`jazz: no such file: ${source}`);
    process.exit(1);
  }
  // A URL becomes stream URLs; a file is its own video and audio source.
  const resolved = isUrl ? resolveUrl(source) : { title: basename(source), video: source, audio: source };
  const video = resolved.video;

  const info = probe(video);
  const frameMs = 1000 / FPS;

  // Enter the alternate screen, clear it, hide the cursor.
  process.stdout.write("\x1b[?1049h\x1b[2J\x1b[?25l");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  const cell = mode === "pixels" ? await queryCellSize() : { width: 8, height: 16 };

  let paused = false;
  let quit = false;
  let seek = 0; // seconds of pending arrow-key seeks, applied at next respawn
  let resized = false;
  let decoder: ReturnType<typeof Bun.spawn> | null = null;
  let audio: ReturnType<typeof Bun.spawn> | null = null;

  function cleanup() {
    try { process.stdin.setRawMode(false); } catch {}
    if (mode === "pixels") process.stdout.write("\x1b_Ga=d,d=A,q=2\x1b\\"); // delete kitty images
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
      drawStatus(position, info.duration, true, cols, totalRows, resolved.title);
      while (paused && !quit) await Bun.sleep(50);
      if (quit) break;
    }

    // Re-measure the terminal on every (re)start so resizes take effect.
    // || not ??: some ptys report 0x0, which must also fall back.
    cols = process.stdout.columns || 80;
    totalRows = process.stdout.rows || 24;
    let w: number, h: number, padLeft: number;
    let kittyC = 0, kittyR = 0; // cell rect the terminal scales pixels into
    if (mode === "pixels") {
      const g = fitGraphics(info.width, info.height, cols, totalRows - 1, cell.width, cell.height);
      w = g.w; h = g.h; padLeft = g.padLeft; kittyC = g.c; kittyR = g.r;
    } else {
      const f = fitToTerminal(info.width, info.height, cols, totalRows - 1);
      const scale = mode === "hd" ? 2 : 1; // quadrants pack 2x2 pixels per cell
      w = f.w * scale; h = f.h * scale; padLeft = f.padLeft;
    }
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
      ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", "-ss", String(position), resolved.audio],
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

        const text =
          mode === "pixels" ? `\x1b[1;${padLeft + 1}H` + kittyFrame(frame, w, h, kittyC, kittyR)
          : mode === "hd" ? "\x1b[H" + frameToQuadrants(frame, w, h, padLeft)
          : "\x1b[H" + frameToText(frame, w, h, padLeft);
        process.stdout.write(text);
        drawStatus(position + frames / FPS, info.duration, false, cols, totalRows, resolved.title);
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
