// 实施文档存储 + 文字提取(txt/md/csv/docx),提取的文字供数字总监审核时参考
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export const FILES_DIR = process.env.CRM_FILES_DIR || "/var/lib/sales-crm/files";
export const MAX_UPLOAD = 50 * 1024 * 1024;

export function saveFile(buf, filename) {
  fs.mkdirSync(FILES_DIR, { recursive: true });
  const ext = path.extname(filename).toLowerCase().replace(/[^.a-z0-9]/g, "");
  const stored = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`;
  fs.writeFileSync(path.join(FILES_DIR, stored), buf);
  return stored;
}

export function filePath(stored) {
  return path.join(FILES_DIR, path.basename(stored));
}

export function removeFile(stored) {
  fs.rmSync(filePath(stored), { force: true });
}

// 读 zip 中的单个条目(docx 本质是 zip),只支持 store / deflate
function readZipEntry(buf, name) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && off + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    if (buf.toString("utf8", off + 46, off + 46 + nameLen) === name) {
      const start = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
      const data = buf.subarray(start, start + csize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      return null;
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 提取文档文字;不支持的格式返回 "" */
export function extractText(buf, filename) {
  const ext = path.extname(filename).toLowerCase();
  try {
    if ([".txt", ".md", ".csv"].includes(ext)) return buf.toString("utf8").replace(/^﻿/, "");
    if (ext === ".docx") {
      const xml = readZipEntry(buf, "word/document.xml");
      if (!xml) return "";
      return decodeXml(
        xml
          .toString("utf8")
          .replace(/<\/w:p>/g, "\n")
          .replace(/<w:tab\/>/g, "\t")
          .replace(/<w:br\/>/g, "\n")
          .replace(/<[^>]+>/g, "")
      )
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }
  } catch {
    return "";
  }
  return "";
}
