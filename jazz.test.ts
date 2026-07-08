import { test, expect } from "bun:test";
import { existsSync } from "fs";
import { pickChar, frameToText, fitToTerminal, fmtTime } from "./jazz.ts";

const VIDEO = "/Users/nick/Developer/video-player/batman-jazz.mp4";

test("pickChar maps dark to blank and bright to dense", () => {
  expect(pickChar(0)).toBe(" ");
  expect(pickChar(255)).toBe("@");
});

test("frameToText shapes bytes into padded lines", () => {
  const bytes = new Uint8Array([0, 255, 128, 0, 255, 128]); // 3 wide, 2 tall
  const lines = frameToText(bytes, 3, 2, 2).split("\n");
  expect(lines.length).toBe(2);
  expect(lines[0].length).toBe(5); // 2 pad + 3 chars
  expect(lines[0]).toBe("   @="); // 0→space, 255→@, 128→=
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

test("ffmpeg pipeline yields exact-size grayscale frames", async () => {
  if (!existsSync(VIDEO)) return; // video not on this machine, skip
  const proc = Bun.spawn([
    "ffmpeg", "-v", "error", "-i", VIDEO,
    "-vf", "fps=12,scale=8:4", "-frames:v", "3",
    "-f", "rawvideo", "-pix_fmt", "gray", "-",
  ], { stdout: "pipe", stderr: "ignore" });
  const bytes = await new Response(proc.stdout).arrayBuffer();
  expect(bytes.byteLength).toBe(8 * 4 * 3); // 3 frames of 8x4 pixels
});
