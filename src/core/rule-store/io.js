// 职责：规则仓落盘原语（原子写、持久写、目录 fsync、时间戳）；依赖：node:crypto、node:fs、node:path。
import { createHash, randomBytes } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 原子写：同目录 tmp + rename；失败清理 tmp，旧文件保持原样。
 * @param {string} file @param {string} text @param {{fs?: typeof nodeFs}} [opts]
 * @returns {{ok:boolean,error?:string}}
 */
export function atomicWriteFile(file, text, opts = {}) {
  const fs = opts.fs || nodeFs
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    fs.writeFileSync(tmp, String(text), 'utf8')
    fs.renameSync(tmp, file)
    return { ok: true }
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* tmp 可能没建出来；清理失败不掩盖原始错误 */ }
    return { ok: false, error: String(err?.message || err) }
  }
}

/** 文本 sha256（事务恢复用：判断文件是否仍是本事务写下的中间态）。 */
export function hashText(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

/**
 * 落盘到磁盘（tmp + fsync + rename + fsync 目录）：墓碑必须先于删文件真正持久化。
 *
 * 为什么不用 atomicWriteFile：rename 只保证"要么旧要么新"，不保证内容到盘。断电后
 * 「文件已删、墓碑没落盘」会让编号被复用——这是 R8 的核心不变式，必须 fsync。
 *
 * @param {string} file @param {string} text @param {{fs?: typeof nodeFs}} [opts]
 * @returns {{ok:boolean,error?:string}}
 */
export function durableWriteFile(file, text, opts = {}) {
  const fs = opts.fs || nodeFs
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  let fd = null
  try {
    const handle = fs.openSync(tmp, 'w')
    fd = handle
    fs.writeFileSync(handle, String(text), 'utf8')
    try { fs.fsyncSync(handle) } catch { /* 部分文件系统/假 fs 不支持 fsync：尽力而为，不掩盖写入 */ }
    fs.closeSync(handle)
    fd = null
    fs.renameSync(tmp, file)
    fsyncDir(dirnameOf(file), fs)
    return { ok: true }
  } catch (err) {
    if (fd !== null) { try { fs.closeSync(fd) } catch { /* 句柄可能已关 */ } }
    try { fs.unlinkSync(tmp) } catch { /* tmp 可能没建出来 */ }
    return { ok: false, error: String(err?.message || err) }
  }
}

/** 目录 fsync（best effort）：rename 的目录项也要到盘，否则崩溃后墓碑文件名可能丢。 */
export function fsyncDir(dir, fs = nodeFs) {
  let fd = null
  try {
    fd = fs.openSync(dir, 'r')
    fs.fsyncSync(fd)
  } catch { /* 目录 fsync 在部分平台不支持，尽力而为 */ } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch { /* 已关 */ } }
  }
}

/** @param {string} file @returns {string} */
export function dirnameOf(file) {
  return dirname(String(file))
}

/** 17 位时间戳（YYYYMMDDHHmmssSSS），与 DB 快照命名口径一致。 */
export function stampNow(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`
}

/** 同一毫秒内多次写入时追加序号，保证快照不互相覆盖。 */
export function uniqueStamp(dir, fs) {
  const base = stampNow()
  let stamp = base
  for (let i = 2; existsSyncSafe(join(dir, `${stamp}.md`), fs); i += 1) stamp = `${base}-${i}`
  return stamp
}

export function existsSyncSafe(path, fs = nodeFs) {
  try { return fs.existsSync(path) } catch { return false }
}
