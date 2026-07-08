import { test, expect } from "bun:test";
import { existsSync } from "fs";
import { pickChar, luminance, frameToText, frameToHalfBlocks, fitToTerminal, fitPixelsToTerminal, fmtTime } from "./jazz.ts";

const VIDEO = "/Users/nick/Developer/video-player/batman-jazz.mp4";

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

test("fitPixelsToTerminal packs two even pixels per cell row", () => {
  const { w, h } = fitPixelsToTerminal(1920, 1080, 100, 40);
  expect(w).toBeLessThanOrEqual(100);
  expect(h).toBeLessThanOrEqual(80); // two pixels per cell row
  expect(h % 2).toBe(0);
});

test("frameToHalfBlocks colors top and bottom pixels of one cell", () => {
  // one column, two rows: red on top, blue below → a single ▀ cell
  const rgb = new Uint8Array([255, 0, 0, 0, 0, 255]);
  const text = frameToHalfBlocks(rgb, 1, 2, 0);
  expect(stripAnsi(text)).toBe("▀");
  expect(text).toContain("38;2;248;0;0"); // top pixel = foreground
  expect(text).toContain("48;2;0;0;248"); // bottom pixel = background
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
