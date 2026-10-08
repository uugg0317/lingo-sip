/**
 * 打包成 .crx：node tools/pack.mjs
 *
 * 为什么需要它——
 * 「加载已解压的扩展」没有"打包"这一步，浏览器也就无从知道什么是"新版本"。
 * 想要一个带版本号、可安装、可（自托管时）自动更新的扩展，就得先有 .crx。
 * 这个脚本把「跑校验 → 打成 .crx → 报出扩展 ID」合成一条命令。
 *
 * 实现：纯 Node（只用内置 zlib / crypto），自己写 ZIP 与 CRX3 头。
 * 与 tools/make-icons.mjs 手写 PNG 是同一个理由：零依赖，
 * 谁 clone 下来都能直接跑，不必先 npm install 一堆打包工具。
 *
 * ⚠️ .keys/lingo-sip.pem 一旦丢失或更换，扩展 ID 就会变，
 *    浏览器会把它当成另一个扩展——学习进度会"消失"。请自行备份。
 *
 * ── CRX3 文件布局（记在这里，省得将来再翻文档）─────────────────────
 *   偏移    内容
 *   0      "Cr24"                       4 字节魔数
 *   4      version = 3                  4 字节小端
 *   8      header 长度                   4 字节小端
 *   12     header（下面的 protobuf）      header 长度
 *   12+len ZIP 归档
 *
 *   header = protobuf CrxFileHeader：
 *     field 2     (sha256_with_rsa) repeated AsymmetricKeyProof
 *                   field 1: public_key (bytes)
 *                   field 2: signature  (bytes)
 *     field 10000 (signed_header_data) bytes
 *
 *   signed_header_data = "CRX3 SignedData"：
 *     \x00 填充到 16 字节 + uint32(crx_id 长度) + crx_id
 *     + uint32(proof 数量) + 依次拼接 public_key
 *
 *   签名对象 = "Cr24" + uint32(3) + uint32(header长度) + header + ZIP
 *
 *   扩展 ID = SHA256(公钥) 取前 16 字节，每字节拆成高低 4 bit，
 *             映射到 a–p 字母表（Chromium EncodeExtensionId 的做法）。
 *
 * 用法：
 *   node tools/pack.mjs                     打包（私钥不存在则自动生成）
 *   node tools/pack.mjs --list              只显示私钥对应的扩展 ID
 *   node tools/pack.mjs --skip-check        跳过校验（不建议）
 *   node tools/pack.mjs --xml               额外生成 dist/updates.xml
 *   node tools/pack.mjs --xml --base-url https://example.com/lingo-sip
 */

import { deflateRawSync } from 'node:zlib';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const DEFAULT_KEY = path.join(ROOT, '.keys', 'lingo-sip.pem');

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
const flagValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

/* ------------------------------------------------------------------ *
 * protobuf 最小写入器（只用到 length-delimited 与 varint）
 * ------------------------------------------------------------------ */
function varint(n) {
  const out = [];
  let v = n;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Buffer.from(out);
}

/** length-delimited 字段（wire type 2）。 */
function ld(fieldNumber, payload) {
  return Buffer.concat([varint((fieldNumber << 3) | 2), varint(payload.length), payload]);
}

/* ------------------------------------------------------------------ *
 * 扩展 ID
 * ------------------------------------------------------------------ */
function idFromPublicKey(publicKeyDer) {
  const hex = createHash('sha256').update(publicKeyDer).digest('hex').slice(0, 32);
  let out = '';
  for (const ch of hex) out += String.fromCharCode(97 + parseInt(ch, 16)); // 0..15 -> a..p
  return out;
}

/* ------------------------------------------------------------------ *
 * 私钥：只在第一次生成，之后必须沿用同一个
 * ------------------------------------------------------------------ */
function loadOrCreateKey(keyPath) {
  if (existsSync(keyPath)) return { pem: readFileSync(keyPath, 'utf8'), created: false };
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  mkdirSync(path.dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, privateKey, { encoding: 'utf8', mode: 0o600 });
  return { pem: privateKey, created: true };
}

/* ------------------------------------------------------------------ *
 * 收集文件：包里必须正好是"扩展运行时需要的"
 * 刻意排除 tools/、docs/、dist/、.keys/、.git/
 * ------------------------------------------------------------------ */
const INCLUDE_DIRS = ['src', 'assets'];
const INCLUDE_FILES = ['manifest.json'];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function collectFiles() {
  const files = [];
  for (const rel of INCLUDE_FILES) {
    const full = path.join(ROOT, rel);
    if (!existsSync(full)) throw new Error(`缺少必需文件：${rel}`);
    files.push(full);
  }
  for (const rel of INCLUDE_DIRS) {
    const full = path.join(ROOT, rel);
    if (existsSync(full)) files.push(...walk(full));
  }
  return files;
}

/* ------------------------------------------------------------------ *
 * 手写 ZIP（deflate + CRC32；Chrome 只认标准 ZIP）
 * ------------------------------------------------------------------ */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** ZIP 头用的是 1980 纪元的 MS-DOS 时间格式。 */
function dosStamp(date) {
  return {
    time: ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff,
    date:
      (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff,
  };
}

function makeZip(files) {
  const chunks = [];
  const centrals = [];
  let offset = 0;
  const stamp = dosStamp(new Date());

  for (const full of files) {
    const name = path.relative(ROOT, full).split(path.sep).join('/');
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = readFileSync(full);
    // ZIP 的 method 8 要的是**裸 deflate**，不是 zlib 包装。
    // deflateSync 会带上 78da 头，Chrome 解不开（会被 verify-crx.mjs 拦下）。
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length; // 压不小就原样存
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // 需要 2.0 才能解 deflate
    local.writeUInt16LE(0, 6); // 无标志位
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // 生成程序版本
    central.writeUInt16LE(20, 6); // 需要的版本
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // 扩展字段
    central.writeUInt16LE(0, 32); // 注释
    central.writeUInt16LE(0, 34); // 起始磁盘
    central.writeUInt16LE(0, 36); // 内部属性
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // 外部属性：普通文件 644（>>>0 转无符号，否则溢出成负数）
    central.writeUInt32LE(offset, 42);

    chunks.push(local, nameBuf, body);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, end]);
}

/* ------------------------------------------------------------------ *
 * CRX3 组装与签名
 * ------------------------------------------------------------------ */
/**
 * crx_id = SHA256(公钥) 的**前 16 字节**，长度固定 16。
 *
 * 注意别和"填充"搞混：padding 是为了让协议前缀（magic 4 + 版本 4 + 长度 4 = 12 字节）
 * 加上 crx_id 之后对齐到 16 字节边界，由调用方在签名数据结构里单独加，
 * **不应该让 crx_id 自身变长**。
 * 这里一开始写错过一次：把 crx_id 补成了 20 字节，导致扩展 ID 多出 4 个字符、
 * 而且签名结构与 Chromium 的要求不符（由 tools/verify-crx.mjs 抓出来）。
 */
function makeCrxId(publicKeyDer) {
  return createHash('sha256').update(publicKeyDer).digest().slice(0, 16);
}

/** 协议前缀（magic + 版本 + header 长度）共 12 字节，补到 16 的倍数。 */
function crxHeaderPadding() {
  return Buffer.alloc(16 - (12 % 16), 0);
}

function buildCrx({ zipBuffer, publicKeyDer, privateKey }) {
  const crxId = makeCrxId(publicKeyDer);

  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(crxId.length, 0);
  const countBuf = Buffer.alloc(4);
  countBuf.writeUInt32LE(1, 0); // 只有一把 proof 密钥
  const signedHeaderData = Buffer.concat([
    crxHeaderPadding(),
    lenBuf,
    crxId,
    countBuf,
    publicKeyDer,
  ]);

  const buildHeader = (signature) => {
    const proof = Buffer.concat([ld(1, publicKeyDer), ld(2, signature)]);
    return Buffer.concat([ld(2, proof), ld(10000, signedHeaderData)]);
  };

  const signable = (headerBytes) => {
    const prefix = Buffer.alloc(12);
    prefix.write('Cr24', 0, 'utf8');
    prefix.writeUInt32LE(3, 4);
    prefix.writeUInt32LE(headerBytes.length, 8);
    return Buffer.concat([prefix, headerBytes, zipBuffer]);
  };

  // RSA-2048 签名恒为 256 字节，所以 header 长度与签名内容无关。
  //
  // 签名覆盖的字节 = 12 字节协议前缀 + header（**签名字段清零**）+ ZIP。
  // 为什么要把签名清零：签名没法给自己签名。Chromium 的做法就是序列化时把
  // 签名字段当空，验证时同样清零再算，这样长度与内容都稳定可复现。
  //
  // 这一段踩了三个坑，全部由 tools/verify-crx.mjs 与临时 diag 脚本抓出来：
  //   1) 对"另一个 header"签名 → 落盘字节与签过名的字节不一致；
  //   2) 以为签名在 header 末尾、直接覆盖最后 256 字节 → 实际末尾是公钥，
  //      而 DER 公钥里本身就含上百个 0，结果把公钥写坏了；
  //   3) 对"带占位签名的 header"签名 → 仍然不是 Chromium 认的对象，
  //      实测只有"清零签名"这一种能复现（见下）。
  const SIG_LEN = 256; // RSA-2048
  const placeholder = Buffer.alloc(SIG_LEN, 0);
  const headerBytes = buildHeader(placeholder);
  const sigOffset = headerBytes.indexOf(placeholder);
  if (sigOffset < 0) throw new Error('找不到占位签名在 header 中的位置');

  // 待签对象：前缀 + header（签名字段为零）+ ZIP
  const signableBytes = signable(headerBytes);
  const signature = cryptoSign('sha256', signableBytes, {
    key: privateKey,
    padding: 1, // RSA_PKCS1_PADDING
  });
  if (signature.length !== SIG_LEN) throw new Error(`签名长度异常：${signature.length}`);

  const finalHeader = Buffer.from(headerBytes);
  signature.copy(finalHeader, sigOffset);
  if (finalHeader.length !== headerBytes.length) throw new Error('header 长度变化，签名会失效');

  const prefix = Buffer.alloc(12);
  prefix.write('Cr24', 0, 'utf8');
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(finalHeader.length, 8);
  return { crx: Buffer.concat([prefix, finalHeader, zipBuffer]), crxId };
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
function main() {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const keyPath = flagValue('--key', DEFAULT_KEY);
  const { pem, created } = loadOrCreateKey(keyPath);

  const privateKey = createPrivateKey(pem);
  const publicKeyDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const id = idFromPublicKey(publicKeyDer);

  if (hasFlag('--list')) {
    console.log(`私钥文件：${keyPath}`);
    console.log(`扩展 ID ：${id}`);
    console.log(`清单版本：${manifest.version}`);
    return;
  }

  console.log('—— 语滴打包 ——');
  console.log(`扩展 ID ：${id}`);
  console.log(`版本号  ：${manifest.version}`);
  console.log(
    created ? `私钥     ：已新建 ${keyPath}（⚠️ 请备份，丢了就换 ID）` : `私钥     ：复用 ${keyPath}`,
  );

  if (!hasFlag('--skip-check')) {
    const check = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'validate.js')], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    if (check.status !== 0) {
      console.error('\n✗ 校验未通过，已中止打包：');
      console.error((check.stdout || '').trim());
      process.exit(1);
    }
    console.log('校验    ：通过 ✓');
  }

  const files = collectFiles();
  const zipBuffer = makeZip(files);
  const { crx } = buildCrx({ zipBuffer, publicKeyDer, privateKey });

  mkdirSync(DIST, { recursive: true });
  const crxPath = path.join(DIST, `lingo-sip-${manifest.version}.crx`);
  writeFileSync(crxPath, crx);

  console.log(`文件数  ：${files.length}`);
  console.log(
    `体积    ：源码 ${(files.reduce((s, f) => s + readFileSync(f).length, 0) / 1024).toFixed(1)} KB` +
      ` → 包 ${(crx.length / 1024).toFixed(1)} KB`,
  );
  console.log(`产物    ：${path.relative(ROOT, crxPath)}`);

  if (hasFlag('--xml')) {
    const baseUrl = flagValue('--base-url', '').replace(/\/$/, '');
    const codebase = baseUrl ? `${baseUrl}/${path.basename(crxPath)}` : path.basename(crxPath);
    const xml =
      `<?xml version='1.0' encoding='UTF-8'?>\n` +
      `<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>\n` +
      `  <app appid='${id}'>\n` +
      `    <updatecheck codebase='${codebase}' version='${manifest.version}' />\n` +
      `  </app>\n` +
      `</gupdate>\n`;
    const xmlPath = path.join(DIST, 'updates.xml');
    writeFileSync(xmlPath, xml, 'utf8');
    console.log(`更新清单：${path.relative(ROOT, xmlPath)}`);
    if (!baseUrl) {
      console.log('          （未指定 --base-url，codebase 只是文件名，需自行托管为可访问 URL）');
    }
  }

  console.log('');
  console.log('下一步：edge://extensions 打开开发人员模式，把上面这个 .crx 拖进去安装。');
  console.log('提示：manifest.json 若加了 update_url，Edge 每几小时会自动检查更新。');
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
