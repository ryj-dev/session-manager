import { test } from 'node:test'
import assert from 'node:assert'
import { parseTranscriptTurns, deriveTranscriptPath } from './turn-parser.ts'

function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj)
}

function userPrompt(text: string, ts = '2026-07-24T04:00:00.000Z', extra: Record<string, unknown> = {}): string {
  return line({ type: 'user', timestamp: ts, message: { role: 'user', content: text }, ...extra })
}

function assistant(blocks: unknown[], ts = '2026-07-24T04:00:05.000Z', extra: Record<string, unknown> = {}): string {
  return line({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: blocks }, ...extra })
}

function toolResult(toolUseId: string, content: unknown, extra: Record<string, unknown> = {}): string {
  return line({
    type: 'user',
    timestamp: '2026-07-24T04:00:06.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
    ...extra,
  })
}

test('single turn: prompt, tool call, result — thinking blocks ignored', () => {
  const jsonl = [
    userPrompt('fix the bug'),
    assistant([
      { type: 'thinking', thinking: 'the bug is in foo()', signature: 'x' },
      { type: 'text', text: 'Looking at foo now.' },
      { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a/foo.ts' } },
    ]),
    toolResult('t1', 'file contents here'),
    assistant([{ type: 'text', text: 'Fixed it.' }], '2026-07-24T04:00:10.000Z'),
  ].join('\n')

  const turns = parseTranscriptTurns(jsonl)
  assert.equal(turns.length, 1)
  const t = turns[0]
  assert.equal(t.promptText, 'fix the bug')
  assert.equal(t.resultText, 'Fixed it.')
  assert.equal(t.endTimestamp, '2026-07-24T04:00:10.000Z')
  // Timeline keeps the narration + tool call; trailing result was popped.
  assert.equal(t.timeline.length, 2)
  assert.equal(t.timeline[0].kind, 'text')
  const call = t.timeline[1]
  assert.equal(call.kind, 'tool')
  assert.equal(call.kind === 'tool' && call.name, 'Read')
  assert.equal(call.kind === 'tool' && call.arg, '/a/foo.ts')
  assert.equal(call.kind === 'tool' && call.resultText, 'file contents here')
})

test('turn boundaries: multiple prompts split turns', () => {
  const jsonl = [
    userPrompt('first', '2026-07-24T04:00:00.000Z'),
    assistant([{ type: 'text', text: 'one' }]),
    userPrompt('second', '2026-07-24T04:05:00.000Z'),
    assistant([{ type: 'text', text: 'two' }]),
  ].join('\n')

  const turns = parseTranscriptTurns(jsonl)
  assert.equal(turns.length, 2)
  assert.equal(turns[0].promptText, 'first')
  assert.equal(turns[0].resultText, 'one')
  assert.equal(turns[1].promptText, 'second')
  assert.equal(turns[1].resultText, 'two')
  assert.equal(turns[1].index, 1)
})

test('edit calls extract structuredPatch diffs and label', () => {
  const jsonl = [
    userPrompt('edit store'),
    assistant([{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/repo/src/store.ts', old_string: 'a', new_string: 'b' } }]),
    toolResult('e1', 'ok', {
      toolUseResult: {
        filePath: '/repo/src/store.ts',
        structuredPatch: [{ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1, lines: ['-a', '+b'] }],
      },
    }),
    assistant([{ type: 'text', text: 'done' }]),
  ].join('\n')

  const turns = parseTranscriptTurns(jsonl)
  assert.equal(turns.length, 1)
  assert.equal(turns[0].diffs.length, 1)
  assert.equal(turns[0].diffs[0].filePath, '/repo/src/store.ts')
  assert.deepEqual(turns[0].diffs[0].hunks[0].lines, ['-a', '+b'])
  assert.equal(turns[0].label, 'edited store.ts')
})

test('Write without structuredPatch synthesizes an all-added diff', () => {
  const jsonl = [
    userPrompt('create file'),
    assistant([{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: '/repo/new.ts', content: 'line1\nline2' } }]),
    assistant([{ type: 'text', text: 'created' }]),
  ].join('\n')

  const turns = parseTranscriptTurns(jsonl)
  assert.equal(turns[0].diffs.length, 1)
  assert.deepEqual(turns[0].diffs[0].hunks[0].lines, ['+line1', '+line2'])
})

test('skips sidechains, meta, command wrappers, and non-message types', () => {
  const jsonl = [
    line({ type: 'ai-title', title: 'x' }),
    line({ type: 'file-history-snapshot' }),
    userPrompt('real prompt'),
    userPrompt('sidechain prompt', '2026-07-24T04:01:00.000Z', { isSidechain: true }),
    assistant([{ type: 'text', text: 'sidechain reply' }], '2026-07-24T04:01:01.000Z', { isSidechain: true }),
    userPrompt('Caveat: the messages below were generated', '2026-07-24T04:01:02.000Z'),
    userPrompt('<command-name>/clear</command-name>', '2026-07-24T04:01:03.000Z'),
    userPrompt('meta note', '2026-07-24T04:01:04.000Z', { isMeta: true }),
    assistant([{ type: 'text', text: 'the answer' }]),
  ].join('\n')

  const turns = parseTranscriptTurns(jsonl)
  assert.equal(turns.length, 1)
  assert.equal(turns[0].promptText, 'real prompt')
  assert.equal(turns[0].resultText, 'the answer')
})

test('interruption marks the current turn without starting a new one', () => {
  const jsonl = [
    userPrompt('long task'),
    assistant([{ type: 'text', text: 'working...' }]),
    userPrompt('[Request interrupted by user]', '2026-07-24T04:02:00.000Z'),
    userPrompt('next prompt', '2026-07-24T04:03:00.000Z'),
    assistant([{ type: 'text', text: 'ok' }]),
  ].join('\n')

  const turns = parseTranscriptTurns(jsonl)
  assert.equal(turns.length, 2)
  assert.equal(turns[0].interrupted, true)
  assert.equal(turns[1].interrupted, false)
})

test('list-content prompts join text blocks and mark images', () => {
  const jsonl = [
    line({
      type: 'user',
      timestamp: '2026-07-24T04:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image', source: {} }] },
    }),
    assistant([{ type: 'text', text: 'a chart' }]),
  ].join('\n')

  const turns = parseTranscriptTurns(jsonl)
  assert.equal(turns.length, 1)
  assert.equal(turns[0].promptText, 'what is this\n[image]')
})

test('malformed lines are skipped without aborting the parse', () => {
  const jsonl = ['not json {{{', userPrompt('hello'), assistant([{ type: 'text', text: 'hi' }])].join('\n')
  const turns = parseTranscriptTurns(jsonl)
  assert.equal(turns.length, 1)
})

test('tool calls without trailing text produce empty result', () => {
  const jsonl = [
    userPrompt('run it'),
    assistant([{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm test' } }]),
    toolResult('b1', 'all pass'),
  ].join('\n')

  const turns = parseTranscriptTurns(jsonl)
  assert.equal(turns[0].resultText, '')
  assert.equal(turns[0].timeline.length, 1)
  assert.equal(turns[0].label, '1 tool call')
})

test('deriveTranscriptPath slugifies the project path', () => {
  const p = deriveTranscriptPath('/Users/ryj/Documents/github/.ideas', 'abc-123')
  assert.ok(p.endsWith('/.claude/projects/-Users-ryj-Documents-github--ideas/abc-123.jsonl'))
})
