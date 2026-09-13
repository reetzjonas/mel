import type {
  ConditionField,
  ConditionOp,
  FilterRule,
  RuleAction,
  RuleCondition,
} from '../../domain/sieve'
import { t, type MsgKey } from '../../lib/i18n'
import { emptyRule } from '../../lib/sieveScript'
import { Icon } from '../../ui/Icon'
import { inputClass, secondaryButtonClass } from '../../ui/styles'

const FIELDS: ConditionField[] = ['from', 'to', 'cc', 'subject']
const OPS: ConditionOp[] = ['contains', 'is']
const ACTION_KINDS: RuleAction['kind'][] = ['fileinto', 'flag', 'markRead', 'discard']

const fieldLabel: Record<ConditionField, MsgKey> = {
  from: 'rule.field.from',
  to: 'rule.field.to',
  cc: 'rule.field.cc',
  subject: 'rule.field.subject',
}
const opLabel: Record<ConditionOp, MsgKey> = {
  contains: 'rule.op.contains',
  is: 'rule.op.is',
}
const actionLabel: Record<RuleAction['kind'], MsgKey> = {
  fileinto: 'rule.action.fileinto',
  flag: 'rule.action.flag',
  markRead: 'rule.action.markRead',
  discard: 'rule.action.discard',
}

const selectClass = `${inputClass} w-auto py-1.5 text-xs`

export function RuleWizard({
  rules,
  folders,
  onChange,
}: {
  rules: FilterRule[]
  /** Folder paths for fileinto; see mailboxPaths in lib/sieveScript.ts. */
  folders: string[]
  onChange: (rules: FilterRule[]) => void
}) {
  const replace = (i: number, rule: FilterRule) =>
    onChange(rules.map((r, at) => (at === i ? rule : r)))

  return (
    <div className="space-y-3">
      {rules.length === 0 && <p className="text-sm text-ink-muted">{t('rule.none')}</p>}

      {rules.map((rule, i) => (
        <RuleCard
          key={i}
          rule={rule}
          folders={folders}
          onChange={(next) => replace(i, next)}
          onRemove={() => onChange(rules.filter((_, at) => at !== i))}
        />
      ))}

      <button
        type="button"
        className={secondaryButtonClass}
        onClick={() => onChange([...rules, emptyRule()])}
      >
        {t('rule.add')}
      </button>
    </div>
  )
}

function RuleCard({
  rule,
  folders,
  onChange,
  onRemove,
}: {
  rule: FilterRule
  folders: string[]
  onChange: (rule: FilterRule) => void
  onRemove: () => void
}) {
  const setCondition = (i: number, condition: RuleCondition) =>
    onChange({ ...rule, conditions: rule.conditions.map((c, at) => (at === i ? condition : c)) })
  const setAction = (i: number, action: RuleAction) =>
    onChange({ ...rule, actions: rule.actions.map((a, at) => (at === i ? action : a)) })

  return (
    <div className="space-y-2 rounded-panel bg-surface-2 p-3">
      <div className="flex items-center gap-2">
        <input
          className={`${inputClass} py-1.5 text-sm`}
          aria-label={t('rule.name')}
          placeholder={t('rule.name')}
          value={rule.name}
          onChange={(e) => onChange({ ...rule, name: e.target.value })}
        />
        <button
          type="button"
          aria-label={`${t('rule.remove')}: ${rule.name || t('rule.untitled')}`}
          onClick={onRemove}
          className="shrink-0 rounded-control p-1.5 text-ink-muted transition-colors hover:bg-surface hover:text-danger"
        >
          <Icon name="trash" size={14} />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
        <span>{t('rule.if')}</span>
        <select
          className={selectClass}
          aria-label={t('rule.if')}
          value={rule.match}
          onChange={(e) => onChange({ ...rule, match: e.target.value as FilterRule['match'] })}
        >
          <option value="all">{t('rule.match.all')}</option>
          <option value="any">{t('rule.match.any')}</option>
        </select>
      </div>

      {rule.conditions.map((condition, i) => (
        <div key={i} className="flex flex-wrap items-center gap-1.5">
          <select
            className={selectClass}
            aria-label={t('rule.field.from')}
            value={condition.field}
            onChange={(e) =>
              setCondition(i, { ...condition, field: e.target.value as ConditionField })
            }
          >
            {FIELDS.map((f) => (
              <option key={f} value={f}>
                {t(fieldLabel[f])}
              </option>
            ))}
          </select>
          <select
            className={selectClass}
            aria-label={t('rule.op.contains')}
            value={condition.op}
            onChange={(e) => setCondition(i, { ...condition, op: e.target.value as ConditionOp })}
          >
            {OPS.map((op) => (
              <option key={op} value={op}>
                {t(opLabel[op])}
              </option>
            ))}
          </select>
          <input
            className={`${inputClass} flex-1 py-1.5 text-xs`}
            aria-label={t('rule.value')}
            placeholder={t('rule.value')}
            value={condition.value}
            onChange={(e) => setCondition(i, { ...condition, value: e.target.value })}
          />
          <button
            type="button"
            aria-label={t('rule.removeCondition')}
            onClick={() =>
              onChange({ ...rule, conditions: rule.conditions.filter((_, at) => at !== i) })
            }
            className="shrink-0 rounded-control p-1.5 text-ink-muted hover:text-danger"
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="text-xs text-accent hover:underline"
        onClick={() =>
          onChange({
            ...rule,
            conditions: [...rule.conditions, { field: 'from', op: 'contains', value: '' }],
          })
        }
      >
        {t('rule.addCondition')}
      </button>

      <p className="pt-1 text-xs text-ink-muted">{t('rule.then')}</p>
      {rule.actions.map((action, i) => (
        <div key={i} className="flex flex-wrap items-center gap-1.5">
          <select
            className={selectClass}
            aria-label={t('rule.then')}
            value={action.kind}
            onChange={(e) => {
              const kind = e.target.value as RuleAction['kind']
              setAction(i, kind === 'fileinto' ? { kind, mailbox: '' } : { kind })
            }}
          >
            {ACTION_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(actionLabel[kind])}
              </option>
            ))}
          </select>
          {action.kind === 'fileinto' && (
            <select
              className={`${selectClass} flex-1`}
              aria-label={t('rule.folder')}
              value={action.mailbox}
              onChange={(e) => setAction(i, { kind: 'fileinto', mailbox: e.target.value })}
            >
              {/* Nothing is preselected: a folder chosen for the user is a
                  guess about where their mail should go. Saving with this
                  still on it is refused rather than quietly doing nothing. */}
              <option value="">—</option>
              {/* The stored folder may have been renamed or may come from
                  another client, so it stays selectable rather than silently
                  becoming the first one in the list. */}
              {!folders.includes(action.mailbox) && action.mailbox && (
                <option value={action.mailbox}>{action.mailbox}</option>
              )}
              {folders.map((path) => (
                <option key={path} value={path}>
                  {path}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            aria-label={t('rule.removeAction')}
            onClick={() => onChange({ ...rule, actions: rule.actions.filter((_, at) => at !== i) })}
            className="shrink-0 rounded-control p-1.5 text-ink-muted hover:text-danger"
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="text-xs text-accent hover:underline"
        onClick={() => onChange({ ...rule, actions: [...rule.actions, { kind: 'flag' }] })}
      >
        {t('rule.addAction')}
      </button>

      <label className="flex items-center gap-2 pt-1 text-xs text-ink-muted">
        <input
          type="checkbox"
          checked={rule.stop}
          onChange={(e) => onChange({ ...rule, stop: e.target.checked })}
        />
        {t('rule.stop')}
      </label>
    </div>
  )
}
