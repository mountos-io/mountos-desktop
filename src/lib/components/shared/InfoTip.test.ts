import { describe, expect, it } from 'vitest'
import { parseBlocks, parseInline } from './InfoTip.svelte'

describe('parseInline', () => {
  it('returns a single text segment for plain text', () => {
    expect(parseInline('plain text')).toEqual([{ kind: 'text', value: 'plain text' }])
  })

  it('parses a bold span', () => {
    expect(parseInline('**Fork:** main')).toEqual([
      { kind: 'bold', value: 'Fork:' },
      { kind: 'text', value: ' main' },
    ])
  })

  it('parses a code span', () => {
    expect(parseInline('use `--once` to settle and exit')).toEqual([
      { kind: 'text', value: 'use ' },
      { kind: 'code', value: '--once' },
      { kind: 'text', value: ' to settle and exit' },
    ])
  })

  it('parses bold and code together, in order', () => {
    expect(parseInline('**Flag:** `--restart`')).toEqual([
      { kind: 'bold', value: 'Flag:' },
      { kind: 'text', value: ' ' },
      { kind: 'code', value: '--restart' },
    ])
  })
})

describe('parseBlocks', () => {
  it('splits on blank lines into separate paragraph blocks', () => {
    const blocks = parseBlocks('First paragraph.\n\nSecond paragraph.')
    expect(blocks).toEqual([
      { kind: 'para', lines: [[{ kind: 'text', value: 'First paragraph.' }]] },
      { kind: 'para', lines: [[{ kind: 'text', value: 'Second paragraph.' }]] },
    ])
  })

  it('keeps single newlines as soft line breaks within one paragraph', () => {
    const blocks = parseBlocks('Line one.\nLine two.')
    expect(blocks).toEqual([
      {
        kind: 'para',
        lines: [[{ kind: 'text', value: 'Line one.' }], [{ kind: 'text', value: 'Line two.' }]],
      },
    ])
  })

  it('detects a bullet-list block via the existing "• " convention and strips the marker', () => {
    const blocks = parseBlocks('• first item\n• second item')
    expect(blocks).toEqual([
      {
        kind: 'list',
        items: [[{ kind: 'text', value: 'first item' }], [{ kind: 'text', value: 'second item' }]],
      },
    ])
  })

  it('does not treat a block as a list unless every line starts with "• "', () => {
    const blocks = parseBlocks('• first item\nnot a bullet')
    expect(blocks).toEqual([
      {
        kind: 'para',
        lines: [[{ kind: 'text', value: '• first item' }], [{ kind: 'text', value: 'not a bullet' }]],
      },
    ])
  })

  it('handles a realistic mixed doc: heading para, then a bullet list, then a closing para', () => {
    const text =
      '**Drift signals:**\n\nSome intro line.\n\n• Uptime < Age -- restarted\n• Age frozen -- heartbeats lost\n\nClosing note.'
    const blocks = parseBlocks(text)
    expect(blocks.map((b) => b.kind)).toEqual(['para', 'para', 'list', 'para'])
    expect(blocks[2]).toEqual({
      kind: 'list',
      items: [[{ kind: 'text', value: 'Uptime < Age -- restarted' }], [{ kind: 'text', value: 'Age frozen -- heartbeats lost' }]],
    })
  })

  it('drops blocks that are entirely blank', () => {
    expect(parseBlocks('\n\n\n')).toEqual([])
  })
})
