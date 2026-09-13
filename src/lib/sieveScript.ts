import type { FilterRule, RuleAction, RuleCondition } from '../domain/sieve'

/*
 * Turning guided rules into a Sieve script, and reading them back out.
 *
 * Reading back is the hard half: a form cannot parse arbitrary Sieve, and
 * pretending otherwise would mean silently rewriting a script someone tuned by
 * hand. So the generator writes what it knows on a marker line, and the reader
 * only ever trusts that line — a script without it is reported as hand-written
 * and is only ever offered as text.
 */

const MARKER = '# mel-rules:v1 '

/** Sieve quoted-string escaping: backslash and double quote, nothing else. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

const HEADER: Record<RuleCondition['field'], string> = {
  from: 'From',
  to: 'To',
  cc: 'Cc',
  subject: 'Subject',
}

function testFor(condition: RuleCondition): string {
  // :is wants the whole header to match, :contains any part of it.
  const matchType = condition.op === 'is' ? ':is' : ':contains'
  return `header ${matchType} ${quote(HEADER[condition.field])} ${quote(condition.value)}`
}

function commandsFor(action: RuleAction): string[] {
  switch (action.kind) {
    case 'fileinto':
      return [`fileinto ${quote(action.mailbox)};`]
    case 'flag':
      return [`addflag "\\\\Flagged";`]
    case 'markRead':
      return [`addflag "\\\\Seen";`]
    case 'discard':
      // `discard` on its own would still leave the implicit keep in place on
      // some servers; `stop` after it is what actually ends the message's run.
      return ['discard;', 'stop;']
  }
}

/** Which extensions the actions in use have to be required up front. */
function requiresFor(rules: FilterRule[]): string[] {
  const needed = new Set<string>()
  for (const rule of rules)
    for (const action of rule.actions) {
      if (action.kind === 'fileinto') needed.add('fileinto')
      if (action.kind === 'flag' || action.kind === 'markRead') needed.add('imap4flags')
    }
  return [...needed].sort()
}

/**
 * The script for a set of rules, with the rules themselves on a marker line.
 *
 * Rules run in order and each is independent unless it says `stop`, which is
 * how a mail can be filed *and* flagged by two rules — the usual expectation,
 * and the reason stop is a per-rule choice rather than the default.
 */
export function toSieveScript(rules: FilterRule[]): string {
  const lines: string[] = [MARKER + JSON.stringify(rules)]
  const requires = requiresFor(rules)
  if (requires.length) lines.push(`require [${requires.map(quote).join(', ')}];`)
  lines.push('')

  for (const rule of rules) {
    if (!rule.conditions.length || !rule.actions.length) continue
    lines.push(`# ${rule.name}`)
    const tests = rule.conditions.map(testFor)
    // A single test needs no anyof/allof wrapper, and reads better without it.
    const condition =
      tests.length === 1
        ? tests[0]!
        : `${rule.match === 'all' ? 'allof' : 'anyof'} (${tests.join(', ')})`
    lines.push(`if ${condition} {`)
    for (const action of rule.actions)
      for (const command of commandsFor(action)) lines.push(`  ${command}`)
    if (rule.stop && !rule.actions.some((a) => a.kind === 'discard')) lines.push('  stop;')
    lines.push('}', '')
  }
  return lines.join('\n')
}

/**
 * The rules a script carries, or null when it was not written here.
 *
 * Null is not an error — it means "show this as text", which is the honest
 * answer for a script edited by hand or by another client. Anything unreadable
 * on the marker line is treated the same way: better to fall back to the text
 * editor than to open a form holding half a rule set.
 */
export function rulesFromScript(script: string): FilterRule[] | null {
  const line = script.split('\n').find((l) => l.startsWith(MARKER))
  if (!line) return null
  try {
    const parsed: unknown = JSON.parse(line.slice(MARKER.length))
    return Array.isArray(parsed) && parsed.every(isRule) ? parsed : null
  } catch {
    return null
  }
}

function isRule(value: unknown): value is FilterRule {
  if (typeof value !== 'object' || value === null) return false
  const rule = value as Partial<FilterRule>
  return (
    typeof rule.name === 'string' &&
    (rule.match === 'all' || rule.match === 'any') &&
    Array.isArray(rule.conditions) &&
    Array.isArray(rule.actions) &&
    typeof rule.stop === 'boolean'
  )
}

/**
 * Drop the marker line, so a script edited as text stops claiming to be
 * generated.
 *
 * Without this, hand-editing the text of a generated script would leave the
 * old rules on the marker: reopening would show the form's version, and
 * saving from the form would quietly throw the hand-written changes away.
 * Losing the marker is the cheaper half of that trade by a wide margin.
 */
export function stripRuleMarker(script: string): string {
  return script
    .split('\n')
    .filter((line) => !line.startsWith(MARKER))
    .join('\n')
}

export function emptyRule(): FilterRule {
  return {
    name: '',
    match: 'all',
    conditions: [{ field: 'from', op: 'contains', value: '' }],
    actions: [{ kind: 'fileinto', mailbox: '' }],
    stop: false,
  }
}
