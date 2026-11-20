// Deterministic subprocess fixture: no model, credentials, CWLink or network.
const fs = require('node:fs');
const path = require('node:path');
let buffer = '';
let pending;
const emit = (record) => process.stdout.write(JSON.stringify(record) + '\n');
const reply = (command, data) =>
  emit({
    type: 'response',
    id: command.id,
    command: command.type,
    success: true,
    data,
  });
const final = (text, reason = 'stop') =>
  emit({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: reason },
  });
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const record = JSON.parse(line);
    fs.appendFileSync(
      path.join(process.cwd(), 'rpc-inputs.jsonl'),
      JSON.stringify({ ...record, fixtureArgs: process.argv.slice(2) }) + '\n',
    );
    if (record.type === 'get_state') {
      const flag = process.argv.includes('--session') ? '--session' : '--session-id';
      const override = path.join(process.cwd(), 'rpc-session-id-override');
      const sessionId = fs.existsSync(override)
        ? fs.readFileSync(override, 'utf8')
        : process.argv[process.argv.indexOf(flag) + 1];
      reply(record, { sessionId });
    }
    if (record.type === 'prompt') {
      const prompt = record.message;
      if (prompt.includes('[HANDLED]')) {
        reply(record, { disposition: 'handled' });
      } else {
        reply(record, { disposition: 'started' });
        emit({ type: 'agent_start' });
        if (prompt.includes('[WAIT]')) continue;
        if (prompt.includes('[INVALID]')) {
          process.stdout.write('not JSON\n');
          continue;
        }
        if (prompt.includes('[UI]')) {
          emit({ type: 'extension_ui_request', id: 'confirm-1', method: 'confirm' });
          continue;
        }
        if (prompt.includes('[EMPTY]')) {
          emit({ type: 'agent_settled', aborted: false });
          continue;
        }
        const markdown =
          '# A freely written result\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n' +
          'Literal Unicode: \u2028 and \u2029. 中文。\n\n' +
          prompt;
        if (prompt.includes('[FAIL]')) {
          final(markdown, 'error');
          emit({ type: 'agent_settled', aborted: false });
        } else if (prompt.includes('[EARLY_END]')) {
          final('intermediate');
          emit({ type: 'agent_end', willRetry: true });
          pending = setTimeout(() => {
            final(markdown);
            emit({ type: 'agent_settled', aborted: false });
          }, 100);
        } else if (prompt.includes('[EXIT]')) {
          final(markdown);
          process.exit(0);
        } else {
          // Split a UTF-8 sequence across chunks, as real pipes can do.
          const output = Buffer.from(
            JSON.stringify({
              type: 'message_end',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: markdown }],
                stopReason: 'stop',
              },
            }) + '\r\n',
          );
          const position = output.indexOf(Buffer.from('中')) + 1;
          process.stdout.write(output.subarray(0, position));
          process.stdout.write(output.subarray(position));
          emit({ type: 'agent_settled', aborted: false });
        }
      }
    }
    if (record.type === 'clear_queue') reply(record, { steering: [], followUp: [] });
    if (record.type === 'abort') {
      clearTimeout(pending);
      emit({ type: 'agent_settled', aborted: true });
      reply(record);
    }
  }
});
process.stdin.on('end', () => {
  clearTimeout(pending);
  process.exit(0);
});
