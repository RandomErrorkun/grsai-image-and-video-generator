/**
 * 把 RGBA 像素编码成 PNG。剪贴板插件只给原始像素，存盘要自己编码。
 * 只用浏览器自带的压缩能力，不引第三方库。
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, data.length);
  const crcInput = new Uint8Array(typeBytes.length + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, typeBytes.length);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(crcInput));
  const result = new Uint8Array(12 + data.length);
  result.set(length, 0);
  result.set(typeBytes, 4);
  result.set(data, 8);
  result.set(crc, 8 + data.length);
  return result;
}

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 像素按行排列，每行从左到右，每点 RGBA 四个字节，长度必须是 width * height * 4。
 * 用 RGBA 加 filter 0 的最简编码，体积换来的省心。
 */
export async function encodePng(rgba: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`invalid image size ${width}x${height}`);
  }
  if (rgba.length !== width * height * 4) {
    throw new Error(`expected ${width * height * 4} bytes of RGBA data, got ${rgba.length}`);
  }

  // 每行前面加一个 filter 类型字节
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    raw[row * (width * 4 + 1)] = 0;
    raw.set(rgba.subarray(row * width * 4, (row + 1) * width * 4), row * (width * 4 + 1) + 1);
  }

  const deflate = new CompressionStream("deflate");
  const writer = deflate.writable.getWriter();
  void writer.write(raw);
  void writer.close();
  const compressed = new Uint8Array(await new Response(deflate.readable).arrayBuffer());

  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header[8] = 8; // 位深
  header[9] = 6; // 颜色类型：RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const parts = [SIGNATURE, chunk("IHDR", header), chunk("IDAT", compressed), chunk("IEND", new Uint8Array(0))];
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
