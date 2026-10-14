// Rasterises ide/assets/icon.svg into the .ico and tile PNGs Windows needs.
import { readFile } from "node:fs/promises";
import { Resvg } from "@resvg/resvg-js";
import { encodeIco } from "./lib.mjs";

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function png(svg, size) {
  return new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
}

/** Returns `{ ico, png70, png150 }` as Buffers. */
export async function renderIcons(svgPath) {
  const svg = await readFile(svgPath);
  return {
    ico: encodeIco(ICO_SIZES.map((size) => ({ size, data: png(svg, size) }))),
    png70: png(svg, 70),
    png150: png(svg, 150),
  };
}
