/**
 * 生成扩展图标：node tools/make-icons.mjs
 *
 * 为什么自己画而不用现成图片？——为了让这个仓库保持"零二进制素材、零依赖"，
 * 任何人 clone 之后跑一条命令就能得到全部尺寸的图标。
 *
 * 实现：纯 Node（只用内置 zlib），4 倍超采样做抗锯齿，然后手写 PNG 编码。
 * 图形：圆角渐变底 + 白色对话框 + 对话框里的两条文字线（就是一张"单词卡"的抽象）。
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'assets', 'icons');
const SIZES = [16, 32, 48, 128];
const SS = 4; // 超采样倍数

/* ------------------------------------------------------------------ *
 * PNG 编码
 * ------------------------------------------------------------------ */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** rgba: Buffer(width*height*4) */
function encodePNG(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ *
 * 几何：圆角矩形 / 三角形的"点是否在内部"判断
 * ------------------------------------------------------------------ */
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

const lerp = (a, b, t) => a + (b - a) * t;

/** 渲染一张 size×size 的图标，返回 RGBA Buffer。 */
function renderIcon(size) {
  const S = size * SS; // 超采样画布
  const out = Buffer.alloc(size * size * 4);

  // 归一化到 0..1 再乘 S，保证任何尺寸下形状比例一致
  const P = (v) => v * S;

  // 背景渐变：左上 #4f5bd5 → 右下 #7c5cd6
  const c1 = [0x4f, 0x5b, 0xd5];
  const c2 = [0x7c, 0x5c, 0xd6];

  const radius = P(0.22);
  const bubble = [P(0.2), P(0.24), P(0.8), P(0.66), P(0.1)]; // x0,y0,x1,y1,r
  const tail = [P(0.3), P(0.6), P(0.3), P(0.82), P(0.48), P(0.64)];
  const bars = [
    [P(0.34), P(0.375), P(0.66), P(0.475), P(0.05)],
    [P(0.34), P(0.535), P(0.56), P(0.635), P(0.05)],
  ];
  const barColor = [0x5a, 0x5e, 0xd6];
  const white = [0xff, 0xff, 0xff];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;

      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = x * SS + sx + 0.5;
          const py = y * SS + sy + 0.5;

          // 超出圆角背景范围 → 完全透明
          if (!inRoundRect(px, py, 0, 0, S, S, radius)) continue;

          const t = (px / S + py / S) / 2;
          let cr = lerp(c1[0], c2[0], t);
          let cg = lerp(c1[1], c2[1], t);
          let cb = lerp(c1[2], c2[2], t);

          const inBubble = inRoundRect(px, py, ...bubble) || inTriangle(px, py, ...tail);
          if (inBubble) {
            cr = white[0];
            cg = white[1];
            cb = white[2];
            for (const bar of bars) {
              if (inRoundRect(px, py, ...bar)) {
                cr = barColor[0];
                cg = barColor[1];
                cb = barColor[2];
                break;
              }
            }
          }

          r += cr;
          g += cg;
          b += cb;
        }
      }

      const samples = SS * SS;
      const idx = (y * size + x) * 4;
      // 用 alpha 表达"圆角外"的空隙：统计有多少子采样点落在图形内
      let inside = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          if (inRoundRect(x * SS + sx + 0.5, y * SS + sy + 0.5, 0, 0, S, S, radius)) inside += 1;
        }
      }
      if (inside === 0) {
        out[idx] = 0;
        out[idx + 1] = 0;
        out[idx + 2] = 0;
        out[idx + 3] = 0;
      } else {
        out[idx] = Math.round(r / inside);
        out[idx + 1] = Math.round(g / inside);
        out[idx + 2] = Math.round(b / inside);
        out[idx + 3] = Math.round((inside / samples) * 255);
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const png = encodePNG(size, renderIcon(size));
  const file = path.join(OUT_DIR, `icon${size}.png`);
  writeFileSync(file, png);
  console.log(`✓ ${path.relative(ROOT, file)}  ${png.length} 字节`);
}
console.log('\n图标已生成，重新加载扩展即可看到。\n');
