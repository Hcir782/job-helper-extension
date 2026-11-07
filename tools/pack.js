/**
 * 打 Release 包：把运行需要的文件压成 zip（排除 .git / node_modules / docs / tests）
 * 用法：node tools/pack.js [输出路径]
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const outFile = process.argv[2] || path.join("D:", "jh-dist", `job-helper-extension-v${MANIFEST.version}.zip`);

const skip = /^(\.git\/|node_modules\/|docs\/|tests\/|tools\/|notes\/|\.tmp-|\.workbuddy\/|\.codebuddy\/)/;
const files = [];
(function walk(dir, base) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, rel);
    else if (!skip.test(rel) && e.name !== ".commit-msg.txt") files.push({ rel, full });
  }
})(ROOT, "");

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
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

const local = [];
const central = [];
let offset = 0;
for (const f of files) {
  const data = fs.readFileSync(f.full);
  const comp = zlib.deflateRawSync(data, { level: 9 });
  const name = Buffer.from(f.rel, "utf8");
  const crc = crc32(data);
  const lh = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]), u16(20), u16(0), u16(8),
    u16(0), u16(0), u32(crc), u32(comp.length), u32(data.length),
    u16(name.length), u16(0), name, comp,
  ]);
  local.push(lh);
  central.push(Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x01, 0x02]), u16(20), u16(20), u16(0), u16(8),
    u16(0), u16(0), u32(crc), u32(comp.length), u32(data.length),
    u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name,
  ]));
  offset += lh.length;
}
const cd = Buffer.concat(central);
const eocd = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x05, 0x06]), u16(0), u16(0),
  u16(files.length), u16(files.length), u32(cd.length), u32(offset), u16(0),
]);

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, Buffer.concat([...local, cd, eocd]));

console.log(`版本：v${MANIFEST.version}`);
console.log(`文件数：${files.length}`);
console.log(`体积：${(fs.statSync(outFile).size / 1024 / 1024).toFixed(2)} MB`);
console.log(`输出：${outFile}`);
