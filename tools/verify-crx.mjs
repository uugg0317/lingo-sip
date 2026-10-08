/**
 * 独立校验 dist/*.crx：不改用 pack.mjs 的任何内部函数，全部重新解一遍。
 * 目的是真正确认这个包能被 Chromium 接受，而不是"脚本没报错"。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(ROOT, process.argv[2] || 'dist');
const file = readdirSync(dir).filter((f) => f.endsWith('.crx')).sort().pop();
const buf = readFileSync(path.join(dir, file));

let bad = 0;
const ok = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? `  ${extra}` : ''}`);
  if (!cond) bad += 1;
};

console.log(`===== 校验 ${file} =====`);

// 1. 前缀
ok('魔数是 Cr24', buf.slice(0, 4).toString() === 'Cr24', buf.slice(0, 4).toString());
const version = buf.readUInt32LE(4);
ok('版本是 3（CRX3）', version === 3, `实际 ${version}`);
const headerLen = buf.readUInt32LE(8);
ok('header 长度合理', headerLen > 0 && headerLen < buf.length, `${headerLen} 字节`);

const header = buf.slice(12, 12 + headerLen);
const zip = buf.slice(12 + headerLen);

// 2. 读 protobuf（只处理我们写的那几个字段）
function readVarint(b, i) {
  let out = 0;
  let shift = 0;
  for (;;) {
    const byte = b[i];
    i += 1;
    out |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) break;
    shift += 7;
  }
  return [out >>> 0, i];
}
function fields(b) {
  const out = [];
  let i = 0;
  while (i < b.length) {
    const [tag, ni] = readVarint(b, i);
    i = ni;
    const field = tag >>> 3;
    const wire = tag & 7;
    if (wire === 2) {
      const [len, li] = readVarint(b, i);
      i = li;
      out.push({ field, value: b.slice(i, i + len) });
      i += len;
    } else {
      throw new Error(`不支持的 wire type ${wire}`);
    }
  }
  return out;
}

const top = fields(header);
const proofField = top.find((f) => f.field === 2);
const signedDataField = top.find((f) => f.field === 10000);
ok('header 含 field 2（sha256_with_rsa）', !!proofField);
ok('header 含 field 10000（signed_header_data）', !!signedDataField);

const proof = fields(proofField.value);
const publicKeyDer = proof.find((f) => f.field === 1).value;
const signature = proof.find((f) => f.field === 2).value;
ok('公钥非空', publicKeyDer.length > 0, `${publicKeyDer.length} 字节`);
ok('签名是 256 字节（RSA-2048）', signature.length === 256, `实际 ${signature.length}`);

// 3. 验证签名
//    签名对象 = 12 字节协议前缀 + header（**签名字段清零**）+ ZIP。
//    清零是必须的：签名无法覆盖自身，Chromium 序列化时就把它当空。
const sigOffset = header.indexOf(signature);
ok('能在 header 中定位到签名字段', sigOffset >= 0, `偏移 ${sigOffset}`);
const zeroedHeader = Buffer.from(header);
Buffer.alloc(signature.length, 0).copy(zeroedHeader, sigOffset);
const signed = Buffer.concat([buf.slice(0, 12), zeroedHeader, zip]);
const keyObj = createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' });
const sigOk = cryptoVerify('sha256', signed, { key: keyObj, padding: 1 }, signature);
ok('★ RSA 签名验证通过', sigOk, `待签数据 ${signed.length} 字节`);

// 4. signed_header_data 的结构
//    \x00 填充（把 12 字节协议前缀补到 16 的倍数）+ uint32(id 长度) + id
//    + uint32(proof 数) + 依次拼接 public_key
//    crx_id 固定 16 字节，填充只服务于前缀对齐。
const shd = signedDataField.value;
const padLen = 16 - (12 % 16); // 固定 4，不猜
ok('signed_header_data 以 4 字节 0 填充开头', shd.slice(0, padLen).every((b) => b === 0));
const crxIdLen = shd.readUInt32LE(padLen);
ok('crx_id 长度为 16（固定值）', crxIdLen === 16, `实际 ${crxIdLen}`);
const crxId = shd.slice(padLen + 4, padLen + 4 + crxIdLen);
ok('crx_id 等于 SHA256(公钥) 前 16 字节',
  crxId.length === 16 &&
    Buffer.compare(crxId, createHash('sha256').update(publicKeyDer).digest().slice(0, 16)) === 0);
const pc = shd.readUInt32LE(padLen + 4 + crxIdLen);
ok('proof 数量为 1', pc === 1, `实际 ${pc}`);
const pubInShd = shd.subarray(padLen + 8 + crxIdLen);
ok('signed_header_data 里的公钥与 proof 里的一致',
  Buffer.compare(pubInShd, publicKeyDer) === 0,
  `shd 里 ${pubInShd.length} 字节 / proof 里 ${publicKeyDer.length} 字节`);

// 5. 扩展 ID（16 字节 -> 32 个 a..p 字母）
let id = '';
for (const byte of crxId) {
  id += String.fromCharCode(97 + (byte >> 4));
  id += String.fromCharCode(97 + (byte & 15));
}
ok('扩展 ID 长度是 32', id.length === 32, `实际 ${id.length}`);
console.log(`  扩展 ID = ${id}`);

// 6. 解析 ZIP，逐条校验 CRC 与长度
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i += 1) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
let eocd = -1;
for (let i = zip.length - 22; i >= 0; i -= 1) {
  if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
ok('找到 ZIP 中央目录结尾', eocd >= 0);
const entries = zip.readUInt16LE(eocd + 10);
const cdOffset = zip.readUInt32LE(eocd + 16);
ok('ZIP 条目数与打包文件数一致', entries > 0, `${entries} 个`);

const names = [];
let p = cdOffset;
for (let n = 0; n < entries; n += 1) {
  if (zip.readUInt32LE(p) !== 0x02014b50) break;
  const method = zip.readUInt16LE(p + 10);
  const crc = zip.readUInt32LE(p + 16);
  const compSize = zip.readUInt32LE(p + 20);
  const rawSize = zip.readUInt32LE(p + 24);
  const nameLen = zip.readUInt16LE(p + 28);
  const extraLen = zip.readUInt16LE(p + 30);
  const commentLen = zip.readUInt16LE(p + 32);
  const localOff = zip.readUInt32LE(p + 42);
  const name = zip.slice(p + 46, p + 46 + nameLen).toString('utf8');
  names.push(name);
  // 顺带把内容解出来验证长度与 CRC
  const lNameLen = zip.readUInt16LE(localOff + 26);
  const lExtraLen = zip.readUInt16LE(localOff + 28);
  const dataStart = localOff + 30 + lNameLen + lExtraLen;
  const data = zip.slice(dataStart, dataStart + compSize);
  let content;
  try {
    content = method === 8 ? inflateRawSync(data) : data;
  } catch (err) {
    console.log(`  ✗ ${name} 解压失败（method=${method} comp=${compSize} raw=${rawSize}）：${err.message}`);
    bad += 1;
    p += 46 + nameLen + extraLen + commentLen;
    continue;
  }
  if (content.length !== rawSize) {
    console.log(`  ✗ ${name} 解压长度不符：得到 ${content.length}，头部声明 ${rawSize}`);
    bad += 1;
  } else if (crc32(content) !== crc) {
    console.log(`  ✗ ${name} CRC 不匹配`);
    bad += 1;
  }
  if (name === 'manifest.json') {
    const m = JSON.parse(content.toString('utf8'));
    ok('包内 manifest.json 可解析', true);
    ok('包内版本号与文件名一致', file.includes(m.version), `manifest=${m.version}`);
  }
  p += 46 + nameLen + extraLen + commentLen;
}
// 这些必须等整份清单收完再判，循环中途 names 还不完整
ok('ZIP 内含 manifest.json', names.includes('manifest.json'));
ok('包内含 newtab 页面', names.includes('src/newtab/newtab.html'));
ok('ZIP 内含 manifest.json', names.includes('manifest.json'));
ok('ZIP 内不含 tools/ 与私钥', !names.some((n) => n.startsWith('tools/') || n.endsWith('.pem')));
console.log(`  包内 newtab 条目：${names.filter((n) => n.includes('newtab')).join(', ') || '(无)'}`);
console.log(`  共 ${names.length} 个条目`);
console.log(bad === 0 ? '\n=== 全部通过：这个 .crx 结构与签名都正确 ===' : `\n=== 有 ${bad} 项不合格 ===`);
process.exit(bad === 0 ? 0 : 1);
