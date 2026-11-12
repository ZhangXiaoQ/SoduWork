'use strict';

const protocolGuard = require('../agent-runtime/protocol-guard');
const agentSource = require('./agent-source.cjs');
const toolFileLocation = require('./tool-file-location.cjs');
const attachmentContract = require('../pi-session/attachment-contract');

// Translate executor events into the SAME message/tool contract as an ordinary
// turn. Cursors and tool identities are scoped to an execution, never a task title.
function create(handle, taskId, options = {}) {
  let source = agentSource.fields(options.sourceAgent);
  const visibleText = (value, final = true) => ['codex-harness', 'codex'].includes(source.sourceAgent?.agentId)
    ? require('../agent-runtime/assistant-text.cjs').cleanStream(value, final) : value;
  const cursors = new Map(), pending = new Map();
  let answers = 0;
  const streams = new Map(), lastTexts = new Map(), transcripts = new Map();
  const liveStreams = options.coalesceText && handle.taskMessageStreaming === true;
  function remember(ref, key, text = '') {
    if (!transcripts.has(ref)) transcripts.set(ref, new Map());
    const rows = transcripts.get(ref);
    if (!rows.has(key)) rows.set(key, '');
    if (text.trim()) rows.set(key, text);
  }
  function finish(ref) {
    const beforeStreams = new Map(Array.from(streams, ([key, row]) => [key, { ...row }]));
    const beforeText = lastTexts.get(ref), beforeAnswers = answers;
    const beforeTranscript = transcripts.has(ref) ? new Map(transcripts.get(ref)) : null;
    const rollback = error => {
      streams.clear(); for (const [key, row] of beforeStreams) streams.set(key, row);
      if (beforeText === undefined) lastTexts.delete(ref); else lastTexts.set(ref, beforeText);
      if (beforeTranscript) transcripts.set(ref, beforeTranscript); else transcripts.delete(ref);
      answers = beforeAnswers; throw error;
    };
    const operations = [], batched = typeof handle.appendTaskBatch === 'function';
    const call = (method, ...args) => {
      if (batched) operations.push({ method, args });
      else return handle[method]?.(...args);
    };
    try {
    if (liveStreams) {
      call('appendTaskRuntimeEvent', { kind: 'task-stream-end', streamPrefix: ref }, taskId);
      for (const [key, row] of streams) {
        if (row.ref !== ref) continue;
        const text = protocolGuard.inspect(visibleText(row.text), { final: true }).text;
        if (row.suppressed && text.trim()) call('appendTaskRuntimeEvent', {
          kind: 'text', text, streamId: key, done: true, ...source }, taskId, row.outputKey);
        if (text.trim()) { remember(ref, key, text); lastTexts.set(ref, text); answers++; }
        streams.delete(key);
      }
    } else for (const [key, row] of streams) {
      if (row.ref !== ref) continue;
      const text = protocolGuard.inspect(visibleText(row.text), { final: true }).text;
      if (text.trim()) {
        call('appendTaskMessage', 'assistant', text, [], taskId, row.outputKey, undefined, source.sourceAgent);
        remember(ref, key, text); lastTexts.set(ref, text); answers++;
      }
      streams.delete(key);
    }
    const delivered = operations.length ? handle.appendTaskBatch(operations) : undefined;
    return delivered?.then ? Promise.resolve(delivered).catch(rollback) : delivered;
    } catch (error) { return rollback(error); }
  }
  function serviceFields(item) {
    const out = {};
    for (const key of ['serviceUrl', 'previewUrl', 'host']) {
      if (typeof item?.[key] === 'string' && item[key].trim()) out[key] = item[key].trim().slice(0, 2000);
    }
    if (Number.isInteger(Number(item?.port)) && Number(item.port) > 0 && Number(item.port) < 65536) {
      out.port = Number(item.port);
    }
    if (Array.isArray(item?.services)) {
      out.services = item.services.slice(0, 8).map(service => {
        if (!service || typeof service !== 'object') return null;
        const row = {};
        for (const key of ['url', 'previewUrl', 'name', 'label']) {
          if (typeof service[key] === 'string' && service[key].trim()) row[key] = service[key].trim().slice(0, 500);
        }
        return Object.keys(row).length ? row : null;
      }).filter(Boolean);
    }
    return out;
  }
  function consume(ref, items) {
    const beforeCursor = cursors.get(ref), beforePending = (pending.get(ref) || []).map(row => ({ ...row }));
    const beforeAnswers = answers, operations = [];
    const beforeStreams = options.coalesceText ? new Map(Array.from(streams, ([key, row]) => [key, { ...row }])) : null;
    const beforeText = lastTexts.get(ref);
    const beforeTranscript = transcripts.has(ref) ? new Map(transcripts.get(ref)) : null;
    const batched = typeof handle.appendTaskBatch === 'function';
    const call = (method, ...args) => {
      if (batched) {
        const previous = operations.at(-1), item = args[0], prior = previous?.args[0];
        // Adjacent cumulative snapshots have one observable final value in a
        // batch. Keep tool/paragraph boundaries and completed receipts intact.
        if (method === 'appendTaskRuntimeEvent' && previous?.method === method &&
            item.kind === 'text' && prior.kind === 'text' && !item.delta && !prior.delta &&
            !prior.done && item.streamId && item.streamId === prior.streamId) operations.pop();
        operations.push({ method, args });
      }
      else if (method === 'appendTaskRuntimeEvent') handle[method]?.(...args);
      else handle[method](...args);
    };
    const rollback = error => {
      if (batched) {
        if (beforeCursor === undefined) cursors.delete(ref); else cursors.set(ref, beforeCursor);
        pending.set(ref, beforePending); answers = beforeAnswers;
        if (beforeStreams) { streams.clear(); for (const [key, row] of beforeStreams) streams.set(key, row); }
        if (beforeText === undefined) lastTexts.delete(ref); else lastTexts.set(ref, beforeText);
        if (beforeTranscript) transcripts.set(ref, beforeTranscript); else transcripts.delete(ref);
      }
      throw error;
    };
    try {
      for (const item of [...(items || [])].sort((a, b) => Number(a.seq) - Number(b.seq))) {
        const seq = Number(item.seq);
        if (!Number.isSafeInteger(seq) || seq <= (cursors.get(ref) || 0)) continue;
        const key = 'task:' + taskId + ':' + ref + ':' + seq;
        const raw = String(item.full || item.text || '');
        if (item.kind === 'tool-preparing') {
          if (item.callId) call('appendTaskRuntimeEvent', { ...item, ...source,
            arguments: toolFileLocation.project(item, options.cwd),
            callId: 'task:' + taskId + ':' + ref + ':call:' + item.callId }, taskId, key);
        } else if (item.kind === 'thinking' || item.kind === 'usage') {
          // These are typed native events, never tool calls or plain replies.
          // A passive cloud view owns their replay alongside normal messages.
          call('appendTaskRuntimeEvent', { ...item, ...source,
            streamId: item.streamId ? (liveStreams
              ? [ref, item.round || item._round || 1, item.seg || 1, item.streamId].join(':')
              : ref + ':' + item.streamId) : undefined }, taskId, key);
        } else if (item.kind === 'user' && options.includeUser) {
          // Keep the same public attachment contract as Pi. Older cloud
          // pages may only contain names; newer runtimes can also provide
          // type, size, and an already-authorized preview reference.
          const files = attachmentContract.publicFiles(item.attachments, { derivePreviewRef: false })
            .map(file => { const copy = { ...file }; if (!copy.previewRef) delete copy.previewRef; return copy; });
          call('appendTaskMessage', 'user', raw, files, taskId, key);
        } else if (item.kind === 'say') {
          const streaming = options.coalesceText && (item.delta || item.streamId);
          let content = raw, transcriptKey = key;
          if (streaming) {
            const streamKey = [ref, item.round || item._round || 1, item.seg || 1, item.streamId || 'message'].join(':');
            transcriptKey = streamKey;
            remember(ref, streamKey); // Reserve the original paragraph order before completion.
            const row = streams.get(streamKey) || { ref, text: '', outputKey: key };
            if (item.full) row.text = String(item.full);
            else if (item.delta) row.text += String(item.text || '');
            else if (raw || !item.done) row.text = raw;
            // Preserve the complete answer; stream buffering is not a display window.
            streams.set(streamKey, row);
            if (liveStreams) {
              const text = protocolGuard.inspect(visibleText(row.text, item.done === true), { final: item.done === true }).text;
              row.suppressed = !text.trim();
              if (text.trim()) call('appendTaskRuntimeEvent', { kind: 'text', text,
                streamId: streamKey, done: item.done === true, at: item.at, ...source }, taskId, key);
              if (item.done) { streams.delete(streamKey); remember(ref, streamKey, text); lastTexts.set(ref, text); answers++; }
              cursors.set(ref, seq); continue;
            }
            if (!item.done) { cursors.set(ref, seq); continue; }
            content = row.text; streams.delete(streamKey);
          }
          const text = protocolGuard.inspect(visibleText(content), { final: true }).text;
          if (text && text.trim()) {
            call('appendTaskMessage', 'assistant', text, [], taskId, key, undefined, source.sourceAgent);
            remember(ref, transcriptKey, text); lastTexts.set(ref, text); answers++;
          }
        } else if (item.kind === 'do' || item.kind === 'out') {
          const active = pending.get(ref) || [];
          const explicit = item.callId ? 'task:' + taskId + ':' + ref + ':call:' + item.callId : '';
          if (item.kind === 'do') {
            const id = explicit || key;
            if (!active.some(x => x.id === id)) {
              call('appendTaskTool', { type: 'tool_execution_start', toolCallId: id,
                toolName: item.tool || 'tool', args: toolFileLocation.project(item, options.cwd),
                toolKind: String(item.toolKind || ''), ...serviceFields(item), ...source }, taskId);
              active.push({ id, name: item.tool, explicit: Boolean(explicit) });
            }
          } else {
            let index = active.findIndex(x => explicit ? x.id === explicit : !item.tool || x.name === item.tool);
            // Mixed-version Pi events can omit the call ID on toolcall_end while
            // supplying it on tool_execution_end. Match the unnamed start only;
            // never finish a different explicitly identified concurrent tool.
            if (index < 0 && explicit) index = active.findIndex(x => !x.explicit && (!item.tool || x.name === item.tool));
            const id = index < 0 ? explicit || key : active.splice(index, 1)[0].id;
            call('appendTaskTool', { type: 'tool_execution_end', toolCallId: id,
              toolName: item.tool || 'tool', result: { content: [{ type: 'text', text: raw }] },
              isError: item.isError === true, ...serviceFields(item), ...source }, taskId);
          }
          pending.set(ref, active);
        }
        cursors.set(ref, seq);
      }
      const delivered = operations.length ? handle.appendTaskBatch(operations) : undefined;
      return delivered?.then ? Promise.resolve(delivered).catch(rollback) : delivered;
    } catch (error) {
      return rollback(error);
    }
  }
  // Late authoritative metadata must not reset cursors, pending tools, or text buffers.
  function setSourceAgent(value) {
    const next = agentSource.fields(value);
    if (next.sourceAgent) source = next;
  }
  return { consume, finish, setSourceAgent, lastText: ref => lastTexts.get(ref) || '', answers: () => answers,
    text: ref => [...(transcripts.get(ref)?.values() || [])].filter(Boolean).join('\n\n') };
}

module.exports = { create };
