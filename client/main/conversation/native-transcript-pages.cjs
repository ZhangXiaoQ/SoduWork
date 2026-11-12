'use strict';

// Bounded byte checkpoints avoid rescanning a JSONL archive for every page.
// Offsets are private to this reader and invalidated on any file version change.
const fs = require('node:fs');
const connectorContext = require('../pi-session/connector-context.cjs');
const { storedMessage } = require('./message-time');
function create() {
  const files = new Map();
  return async function page(file, options, guard = () => {}) {
    const stat = await fs.promises.stat(file);
    const version = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
    let cached = files.get(file);
    if (!cached || cached.version !== version) {
      cached = { version, points: new Map([[0, 0]]) }; files.set(file, cached);
      if (files.size > 64) files.delete(files.keys().next().value);
    }
    const offset = options.offset || 0, limit = options.limit || 50;
    let index = 0, start = 0;
    for (const [position, byte] of cached.points) if (position <= offset && position >= index) { index = position; start = byte; }
    let remainder = Buffer.alloc(0), byte = start, bytes = 0, more = false;
    const items = [], input = fs.createReadStream(file, { start, highWaterMark: 64 * 1024 });
    function line(raw, nextByte) {
      let event;
      try { event = JSON.parse(raw.toString('utf8')); } catch (_) { return true; }
      const message = event.type === 'message' ? event.message : null;
      if (!message || !['user', 'assistant'].includes(message.role)) return true;
      if (index < offset) { index++; return true; }
      if (items.length >= limit) { more = true; return false; }
      const rawText = typeof message.content === 'string' ? message.content :
        (Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'text').map(block => String(block.text || '')).join('\n');
      // Archives retain runtime input; public history must expose the same
      // user text as the live composer, including for relay acknowledgement.
      const text = message.role === 'user' ? connectorContext.strip(rawText) : rawText;
      const size = Buffer.byteLength(text);
      if (size > 1024 * 1024) throw Error('单条消息超过1MB，当前只读接口无法返回');
      if (bytes + size > 1024 * 1024 && items.length) { more = true; return false; }
      index++; bytes += size;
      // Use the same immutable turn clock as native replay. A provider's
      // assistant timestamp marks generation start, not reply completion.
      const timed = storedMessage(event);
      const timestamp = message.role === 'user' ? timed.sentAt : timed.completedAt;
      items.push({ id: String(event.id || index), role: message.role, text,
        timestamp: timestamp ? new Date(timestamp).toISOString() : '',
        hasNonTextContent: Array.isArray(message.content) && message.content.some(block => block.type !== 'text') });
      cached.points.set(index, nextByte);
      if (cached.points.size > 2048) {
        const keys = cached.points.keys(); let oldest = keys.next().value;
        if (oldest === 0) oldest = keys.next().value;
        cached.points.delete(oldest);
      }
      return true;
    }
    try {
      outer: for await (const chunk of input) {
        guard(); remainder = Buffer.concat([remainder, chunk]);
        let consumed = 0, end;
        while ((end = remainder.indexOf(10, consumed)) >= 0) {
          const nextByte = byte + end + 1;
          if (!line(remainder.subarray(consumed, end), nextByte)) break outer;
          consumed = end + 1;
        }
        byte += consumed; remainder = remainder.subarray(consumed);
        if (remainder.length > 8 * 1024 * 1024) throw Error('会话存档单行过大，请在原执行底座查看');
      }
      if (!more && remainder.length) line(remainder, stat.size);
    } finally { input.destroy(); }
    guard();
    const current = await fs.promises.stat(file);
    if ([current.dev, current.ino, current.size, current.mtimeMs, current.ctimeMs].join(':') !== version) {
      files.delete(file); throw Error('会话正在更新，请稍后重新读取');
    }
    return { items, nextOffset: more ? offset + items.length : null };
  };
}
module.exports = { create };
