import { test, expect } from "bun:test";
import { existsSync } from "fs";
import { pickChar, luminance, frameToText, frameToQuadrants, kittyFrame, fitToTerminal, fitGraphics, fmtTime } from "./jazz.ts";

import { homedir } from "os";
const VIDEO = `${homedir()}/.config/jazz/batman-jazz.mp4`;

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

test("luminance weighs green heaviest", () => {
  expect(luminance(0, 0, 0)).toBe(0);
  expect(luminance(255, 255, 255)).toBeCloseTo(255);
  expect(luminance(0, 255, 0)).toBeGreaterThan(luminance(255, 0, 0));
});

test("pickChar maps dark to blank and bright to dense", () => {
  expect(pickChar(0)).toBe(" ");
  expect(pickChar(255)).toBe("@");
});

test("frameToText paints cells and pads lines", () => {
  // one row: a black pixel then a white pixel, padded by one column
  const rgb = new Uint8Array([0, 0, 0, 255, 255, 255]);
  const text = frameToText(rgb, 2, 1, 1);
  expect(stripAnsi(text)).toBe("  @");
  // white pixel: glyph brightened to 240 (quantized /16), background dimmed to 96
  expect(text).toContain("38;2;240;240;240");
  expect(text).toContain("48;2;96;96;96");
  // black pixel still gets a painted (black) background
  expect(text).toContain("48;2;0;0;0");
  expect(text.endsWith("\x1b[0m")).toBe(true);
});

test("frameToQuadrants splits a cell into bright and dark pixels", () => {
  // one 2x2 cell: white top row, black bottom row → ▀ with white fg, black bg
  const rgb = new Uint8Array([255, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0]);
  const text = frameToQuadrants(rgb, 2, 2, 0);
  expect(stripAnsi(text)).toBe("▀");
  expect(text).toContain("38;2;248;248;248"); // bright pair averaged into fg
  expect(text).toContain("48;2;0;0;0"); // dark pair averaged into bg
});

test("kittyFrame emits a single well-formed chunk for a tiny frame", () => {
  const rgb = new Uint8Array([255, 0, 0]); // one red pixel
  const s = kittyFrame(rgb, 1, 1, 2, 1);
  expect(s.startsWith("\x1b_Ga=T,f=24,i=1,q=2,C=1,s=1,v=1,c=2,r=1,m=0;")).toBe(true);
  expect(s.endsWith("\x1b\\")).toBe(true);
});

test("kittyFrame chunks large frames at 4096 bytes of payload", () => {
  const rgb = new Uint8Array(9000); // → 12000 base64 chars → 3 chunks
  const s = kittyFrame(rgb, 60, 50, 10, 5);
  const chunks = s.split("\x1b\\").filter(Boolean);
  expect(chunks.length).toBe(3);
  expect(chunks[1].startsWith("\x1b_Gm=1;")).toBe(true);
  expect(chunks[2].startsWith("\x1b_Gm=0;")).toBe(true);
  for (const c of chunks) {
    expect(c.split(";")[1].length).toBeLessThanOrEqual(4096);
  }
});

test("fitGraphics fits pixels and reports the cell rect", () => {
  // 100x40 cells of 10x20 px → 1000x800 px area; 16:9 video → 1000x563
  const g = fitGraphics(1920, 1080, 100, 40, 10, 20);
  expect(g.w).toBe(1000);
  expect(g.h).toBe(563);
  expect(g.c).toBe(100);
  expect(g.r).toBe(29); // ceil(563/20)
  expect(g.padLeft).toBe(0);
});

test("fitGraphics caps transmitted width at 1280", () => {
  // huge terminal: 400 cells * 10px = 4000px wide
  const g = fitGraphics(1920, 1080, 400, 120, 10, 20);
  expect(g.w).toBe(1280);
  expect(g.c).toBeGreaterThan(200); // display rect still spans the terminal
});

test("fitToTerminal keeps the video inside the terminal", () => {
  const { w, h, padLeft } = fitToTerminal(1920, 1080, 100, 40);
  expect(w).toBeLessThanOrEqual(100);
  expect(h).toBeLessThanOrEqual(40);
  expect(w + padLeft).toBeLessThanOrEqual(100);
});

test("fmtTime formats with and without hours", () => {
  expect(fmtTime(83)).toBe("01:23");
  expect(fmtTime(3600)).toBe("1:00:00");
});

test("ffmpeg pipeline yields exact-size rgb frames", async () => {
  if (!existsSync(VIDEO)) return; // video not on this machine, skip
  const proc = Bun.spawn([
    "ffmpeg", "-v", "error", "-i", VIDEO,
    "-vf", "fps=12,scale=8:4,normalize=smoothing=30", "-frames:v", "3",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ], { stdout: "pipe", stderr: "ignore" });
  const bytes = await new Response(proc.stdout).arrayBuffer();
  expect(bytes.byteLength).toBe(8 * 4 * 3 * 3); // 3 frames of 8x4 rgb pixels
});
