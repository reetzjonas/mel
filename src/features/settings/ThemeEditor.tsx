import { useEffect, useState } from 'react'
import {
  contrastChecks,
  deriveOverrides,
  readBasePalette,
  tuningFromPalette,
  useThemeTuning,
  type ThemeTuning,
} from '../../app/themeTuning'
import { t } from '../../lib/i18n'
import type { ContrastGrade } from '../../lib/oklch'
import { secondaryButtonClass } from '../../ui/styles'

/**
 * The guided theme editor.
 *
 * Four controls, not nineteen: hue and intensity for the accent, hue and tint
 * for the neutrals. Lightness is never exposed, because the palette's
 * readability lives in its lightness ladders — see `app/themeTuning.ts`.
 *
 * Everything applies as it is dragged. There is no Save, and no preview
 * swatch standing in for the real thing: the app *is* the preview, sitting
 * right behind this dialog.
 */

const GRADE_TONE: Record<ContrastGrade, string> = {
  AAA: 'text-success',
  AA: 'text-success',
  'AA-large': 'text-honey',
  fail: 'text-danger',
}

const GRADE_LABEL: Record<ContrastGrade, string> = {
  AAA: 'AAA',
  AA: 'AA',
  'AA-large': 'AA·L',
  fail: '✕',
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onChange: (v: number) => void
}) {
  return (
    <label className="flex items-center gap-3 text-[13px]">
      <span className="w-28 shrink-0 text-ink-muted">{label}</span>
      <input
        type="range"
        className="h-1.5 min-w-0 flex-1 cursor-pointer accent-accent"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {/* Tabular figures are global, so the number does not jitter while dragging. */}
      <span className="w-12 shrink-0 text-right text-ink-subtle">{format(value)}</span>
    </label>
  )
}

export function ThemeEditor() {
  const { tuning, set, reset } = useThemeTuning()
  /*
   * The palette as the stylesheet has it, read once per visit to this screen.
   * readBasePalette lifts our overrides before reading, so this is always the
   * design's own values rather than the last thing the sliders produced.
   */
  const [base, setBase] = useState<ReadonlyMap<string, string>>(() => new Map())
  useEffect(() => {
    const root = document.documentElement
    const palette = readBasePalette(root)
    /*
     * Synchronising with an external system, which is what effects are for:
     * the palette lives in the stylesheet and can only be measured once the
     * document exists. Reading it during render would touch the DOM mid-render
     * — strictly worse than the extra pass this costs once per visit.
     */
    // oxlint-disable-next-line set-state-in-effect
    setBase(palette)
    // readBasePalette stripped the live overrides to read cleanly; put them
    // back, or opening settings would reset the screen behind it.
    if (tuning) for (const [k, v] of deriveOverrides(palette, tuning)) root.style.setProperty(k, v)
    /*
     * Deliberately once, on mount. `tuning` is read here but must not be a
     * dependency: re-running on every slider move would re-read the palette
     * with the overrides just stripped, and the editor would fight itself.
     * The ThemeProvider is what re-derives on a theme change.
     */
    // oxlint-disable-next-line exhaustive-deps
  }, [])

  if (base.size === 0) return null

  const current: ThemeTuning = tuning ?? tuningFromPalette(base)
  const shown = tuning ? deriveOverrides(base, current) : base
  const checks = contrastChecks(shown)
  const update = (patch: Partial<ThemeTuning>) => set({ ...current, ...patch })

  return (
    <div className="space-y-4">
      <div className="space-y-2.5">
        <Slider
          label={t('theme.accentHue')}
          value={current.accentHue}
          min={0}
          max={360}
          step={1}
          format={(v) => `${Math.round(v)}°`}
          onChange={(accentHue) => update({ accentHue })}
        />
        <Slider
          label={t('theme.accentChroma')}
          value={current.accentChroma}
          min={0}
          max={1.6}
          step={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(accentChroma) => update({ accentChroma })}
        />
        <Slider
          label={t('theme.surfaceHue')}
          value={current.surfaceHue}
          min={0}
          max={360}
          step={1}
          format={(v) => `${Math.round(v)}°`}
          onChange={(surfaceHue) => update({ surfaceHue })}
        />
        <Slider
          label={t('theme.surfaceTint')}
          value={current.surfaceTint}
          min={0}
          max={4}
          step={0.1}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(surfaceTint) => update({ surfaceTint })}
        />
      </div>

      {/*
        Measured, not promised. Holding lightness steady keeps the ladders,
        but WCAG weights the sRGB primaries, so saturation moves the figure
        too — see lib/oklch.ts.
      */}
      <dl className="space-y-1 rounded-control bg-surface-2 px-3 py-2.5 text-xs">
        {checks.map((check) => (
          <div key={check.labelKey} className="flex items-center justify-between gap-3">
            <dt className="truncate text-ink-muted">
              {t(check.labelKey as 'theme.contrast.body')}
            </dt>
            <dd className={`shrink-0 font-medium ${GRADE_TONE[check.grade]}`}>
              {check.ratio.toFixed(1)}:1 · {GRADE_LABEL[check.grade]}
            </dd>
          </div>
        ))}
      </dl>

      <div className="space-y-1">
        <button type="button" disabled={!tuning} className={secondaryButtonClass} onClick={reset}>
          {t('theme.reset')}
        </button>
        <p className="text-xs text-ink-subtle">{t('theme.hint')}</p>
      </div>
    </div>
  )
}
