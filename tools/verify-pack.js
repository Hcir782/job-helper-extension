const fs = require("fs");
const zlib = require("zlib");

const buf = fs.readFileSync(process.argv[2]);
const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
const count = buf.readUInt16LE(eocd + 10);

const crcTable = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b) => {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

let ok = 0;
let bad = 0;
let p = 0;
const names = [];
const contents = {};
while (p < eocd && buf.readUInt32LE(p) === 0x04034b50) {
  const crc = buf.readUInt32LE(p + 14);
  const csize = buf.readUInt32LE(p + 18);
  const usize = buf.readUInt32LE(p + 22);
  const nlen = buf.readUInt16LE(p + 26);
  const elen = buf.readUInt16LE(p + 28);
  const name = buf.slice(p + 30, p + 30 + nlen).toString("utf8");
  const comp = buf.slice(p + 30 + nlen + elen, p + 30 + nlen + elen + csize);
  const raw = zlib.inflateRawSync(comp);
  if (raw.length === usize && crc32(raw) === crc) ok++;
  else {
    bad++;
    console.log("CRC 不符:", name);
  }
  names.push(name);
  contents[name] = raw;
  p += 30 + nlen + elen + csize;
}

console.log("条目数:", count, " CRC 通过:", ok, " 失败:", bad);

// 关键校验：manifest 里引用的每个脚本都必须真的在包里
const mf = JSON.parse(contents["manifest.json"].toString("utf8"));
const refs = new Set();
const popupHtml = contents["popup.html"].toString("utf8");
for (const m of popupHtml.matchAll(/<script[^>]*src="([^"]+)"/g)) refs.add(m[1]);
for (const m of popupHtml.matchAll(/link[^>]*href="([^"]+\.css)"/g)) refs.add(m[1]);
refs.add(mf.background.service_worker);
(mf.content_scripts || []).forEach((cs) => cs.js.forEach((f) => refs.add(f)));
refs.add(mf.action.default_popup);

console.log("\nmanifest / popup 引用的资源是否齐全：");
let missing = 0;
[...refs].sort().forEach((r) => {
  const has = names.includes(r);
  if (!has) missing++;
  console.log("  " + (has ? "有" : "缺") + "  " + r);
});
console.log("\n缺失数量:", missing);
console.log("版本:", mf.version);
