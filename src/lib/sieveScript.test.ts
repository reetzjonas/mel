import { describe, expect, it } from 'vitest'
import type { FilterRule } from '../domain/sieve'
import {
  emptyRule,
  mailboxPaths,
  ruleForSender,
  rulesFromScript,
  stripRuleMarker,
  toSieveScript,
  unfinishedRules,
} from './sieveScript'

const rule = (over: Partial<FilterRule> = {}): FilterRule => ({
  name: 'Newsletters',
  match: 'all',
  conditions: [{ field: 'from', op: 'contains', value: 'news@example.test' }],
  actions: [{ kind: 'fileinto', mailbox: 'News' }],
  stop: false,
  ...over,
})

describe('generating a script', () => {
  it('requires only the extensions the actions actually use', () => {
    // Requiring an extension the server does not have fails the whole script,
    // so this must not list anything on speculation.
    expect(toSieveScript([rule()])).toContain('require ["fileinto"];')
    expect(toSieveScript([rule({ actions: [{ kind: 'flag' }] })])).toContain(
      'require ["imap4flags"];',
    )
    expect(toSieveScript([rule({ actions: [{ kind: 'discard' }] })])).not.toContain('require')
  })

  it('writes a single condition without an allof wrapper', () => {
    expect(toSieveScript([rule()])).toContain('if header :contains "From" "news@example.test" {')
  })

  it('wraps several conditions in allof or anyof', () => {
    const two = rule({
      conditions: [
        { field: 'from', op: 'contains', value: 'a' },
        { field: 'subject', op: 'is', value: 'b' },
      ],
    })

    expect(toSieveScript([two])).toContain(
      'if allof (header :contains "From" "a", header :is "Subject" "b") {',
    )
    expect(toSieveScript([{ ...two, match: 'any' }])).toContain('if anyof (')
  })

  it('escapes quotes and backslashes in what the user typed', () => {
    /*
     * Without this a subject containing a double quote closes the string and
     * the rest of the rule becomes syntax — the script stops parsing, or
     * worse, still parses as something nobody asked for.
     */
    const tricky = rule({
      conditions: [{ field: 'subject', op: 'is', value: 'say "hi" \\ bye' }],
      actions: [{ kind: 'fileinto', mailbox: 'Odd "folder"' }],
    })

    const script = toSieveScript([tricky])

    expect(script).toContain('header :is "Subject" "say \\"hi\\" \\\\ bye"')
    expect(script).toContain('fileinto "Odd \\"folder\\""')
  })

  it('adds stop only when the rule asks for it', () => {
    expect(toSieveScript([rule({ stop: true })])).toContain('  stop;')
    expect(toSieveScript([rule()])).not.toContain('stop;')
  })

  it('does not add a second stop after discarding', () => {
    // discard already ends the message's run; a second stop would be noise.
    const script = toSieveScript([rule({ actions: [{ kind: 'discard' }], stop: true })])

    expect(script.match(/stop;/g)).toHaveLength(1)
  })

  it('skips a rule with nothing to match or nothing to do', () => {
    // A half-filled rule in the form must not become an `if {}` the server
    // rejects, taking every other rule down with it.
    expect(toSieveScript([rule({ conditions: [] })])).not.toContain('if ')
    expect(toSieveScript([rule({ actions: [] })])).not.toContain('if ')
  })
})

describe('an action that is not finished', () => {
  it('leaves a fileinto with no folder out, rather than filing into nowhere', () => {
    // The folder select starts empty on purpose — guessing a destination is
    // worse than asking — so the generator must not emit `fileinto ""`.
    const script = toSieveScript([
      rule({ actions: [{ kind: 'fileinto', mailbox: '' }, { kind: 'flag' }] }),
    ])

    // The command, not the word: the marker line still carries the unfinished
    // action so the form shows it again, which is the point of keeping it.
    expect(script).not.toContain('fileinto "')
    expect(script).toContain('addflag')
    expect(script).toContain('require ["imap4flags"];')
  })

  it('skips a rule whose only action has no folder', () => {
    expect(toSieveScript([rule({ actions: [{ kind: 'fileinto', mailbox: '' }] })])).not.toContain(
      'if ',
    )
  })

  it('names the rules the form still has to ask about', () => {
    // Saving these would report success for rules that generate nothing.
    const ok = rule()
    const missing = rule({ name: 'Unfinished', actions: [{ kind: 'fileinto', mailbox: '' }] })

    expect(unfinishedRules([ok, missing]).map((r) => r.name)).toEqual(['Unfinished'])
  })
})

describe('ruleForSender', () => {
  it('matches the sender and leaves the folder to be chosen', () => {
    const seeded = ruleForSender('news@example.test')

    expect(seeded.conditions).toEqual([
      { field: 'from', op: 'contains', value: 'news@example.test' },
    ])
    expect(seeded.actions).toEqual([{ kind: 'fileinto', mailbox: '' }])
  })
})

describe('mailboxPaths', () => {
  const box = (id: string, name: string, parentId: string | null = null) =>
    ({ id, name, parentId }) as never

  it('spells a nested folder as the path fileinto needs', () => {
    // Two "Archive" folders under different parents are different
    // destinations, so a bare name would not say which.
    expect(mailboxPaths([box('a', 'Work'), box('b', 'Archive', 'a')])).toContain('Work/Archive')
  })

  it('survives a parent chain that points at itself', () => {
    expect(mailboxPaths([box('a', 'Loop', 'a')])).toEqual(['Loop'])
  })

  it('stops at a parent it does not have', () => {
    expect(mailboxPaths([box('b', 'Orphan', 'gone')])).toEqual(['Orphan'])
  })
})

describe('reading rules back', () => {
  it('round-trips what it wrote', () => {
    const rules = [
      rule(),
      rule({ name: 'Flag the boss', match: 'any', actions: [{ kind: 'flag' }], stop: true }),
    ]

    expect(rulesFromScript(toSieveScript(rules))).toEqual(rules)
  })

  it('round-trips values that needed escaping', () => {
    // The marker line is JSON, so it escapes independently of the Sieve
    // string below it — worth pinning, since getting one right and the other
    // wrong would show a different rule than the one that runs.
    const rules = [rule({ conditions: [{ field: 'subject', op: 'is', value: 'a "b" \\ c' }] })]

    expect(rulesFromScript(toSieveScript(rules))).toEqual(rules)
  })

  it('reports a hand-written script as not readable, rather than guessing', () => {
    expect(rulesFromScript('require ["fileinto"];\nif true { fileinto "X"; }\n')).toBeNull()
  })

  it('falls back to text when the marker line is damaged', () => {
    expect(rulesFromScript('# mel-rules:v1 {not json\n')).toBeNull()
    expect(rulesFromScript('# mel-rules:v1 {"not":"an array"}\n')).toBeNull()
    expect(rulesFromScript('# mel-rules:v1 [{"name":"half"}]\n')).toBeNull()
  })
})

describe('stripRuleMarker', () => {
  it('makes a hand-edited script stop claiming to be generated', () => {
    /*
     * Otherwise the marker still describes the rules as they were before the
     * edit: reopening would show the form's version of the script, and saving
     * from the form would throw the hand-written changes away without a word.
     */
    const edited = toSieveScript([rule()]) + '\n# tweaked by hand\n'

    expect(rulesFromScript(stripRuleMarker(edited))).toBeNull()
    expect(stripRuleMarker(edited)).toContain('# tweaked by hand')
  })

  it('leaves a script that never had one alone', () => {
    expect(stripRuleMarker('if true { stop; }')).toBe('if true { stop; }')
  })
})

describe('emptyRule', () => {
  it('starts with one condition and one action, so the form has something to show', () => {
    const fresh = emptyRule()

    expect(fresh.conditions).toHaveLength(1)
    expect(fresh.actions).toHaveLength(1)
  })
})
