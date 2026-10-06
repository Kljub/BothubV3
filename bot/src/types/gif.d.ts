// Types of the two small GIF libraries (CommonJS, no own types): only what
// cards.ts uses. Imported as default export (import gifenc from 'gifenc').
declare module 'omggif' {
  export class GifReader {
    constructor(buf: Uint8Array);
    width: number;
    height: number;
    numFrames(): number;
    frameInfo(i: number): { x: number; y: number; width: number; height: number; delay: number; disposal: number };
    decodeAndBlitFrameRGBA(i: number, pixels: Uint8Array): void;
  }
  const omggif: { GifReader: typeof GifReader };
  export default omggif;
}
declare module 'gifenc' {
  type Palette = number[][];
  interface Encoder {
    writeFrame(index: Uint8Array, width: number, height: number, opts: { palette?: Palette; delay?: number; transparent?: boolean; transparentIndex?: number; dispose?: number }): void;
    finish(): void;
    bytes(): Uint8Array;
  }
  const gifenc: {
    GIFEncoder(): Encoder;
    quantize(rgba: Uint8ClampedArray | Uint8Array, maxColors: number, opts?: { format?: string; oneBitAlpha?: boolean | number }): Palette;
    applyPalette(rgba: Uint8ClampedArray | Uint8Array, palette: Palette, format?: string): Uint8Array;
  };
  export default gifenc;
}
