import type { ComponentProps } from 'react'
import { Icon } from './Icon'
import { inputClass } from './styles'

/**
 * A native `<select>` wearing the app's own control styling.
 *
 * Native on purpose: the mobile picker, keyboard behaviour and assistive tech
 * all come for free, and Playwright's `selectOption` keeps working. What the
 * browser draws around it does not follow the palette, so the arrow is dropped
 * (`appearance-none`) and replaced with the icon set's chevron. The open list
 * is coloured in `index.css`, which is the only place it can be reached from.
 *
 * `className` lands on the wrapper rather than on the control: the chevron is
 * positioned against it, so a width set on the control instead would leave the
 * arrow floating somewhere to the right of it. Padding and type size, which do
 * belong to the control, go through `controlClassName`.
 */
export function Select({
  className = '',
  controlClassName = '',
  children,
  ...props
}: ComponentProps<'select'> & { controlClassName?: string }) {
  return (
    <span className={`relative block w-full ${className}`}>
      <select {...props} className={`${inputClass} appearance-none pr-9 ${controlClassName}`}>
        {children}
      </select>
      <Icon
        name="chevronDown"
        className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-ink-muted"
      />
    </span>
  )
}
