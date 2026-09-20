import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { OverflowMenu } from './OverflowMenu'

afterEach(cleanup)

it('names compact actions and supports keyboard navigation', async () => {
  const first = vi.fn()
  const second = vi.fn()
  render(
    <OverflowMenu
      label="More actions"
      actions={[
        { label: 'First action', onSelect: first },
        { label: 'Second action', icon: 'folder', onSelect: second, pressed: true },
      ]}
    />,
  )

  const trigger = screen.getByRole('button', { name: 'More actions' })
  fireEvent.click(trigger)
  expect(trigger).toHaveAttribute('aria-expanded', 'true')

  const firstItem = screen.getByRole('menuitem', { name: 'First action' })
  const secondItem = screen.getByRole('menuitemcheckbox', { name: 'Second action' })
  await waitFor(() => expect(firstItem).toHaveFocus())
  expect(secondItem).toHaveAttribute('aria-checked', 'true')

  fireEvent.keyDown(firstItem, { key: 'ArrowDown' })
  expect(secondItem).toHaveFocus()
  fireEvent.click(secondItem)

  expect(second).toHaveBeenCalledOnce()
  expect(first).not.toHaveBeenCalled()
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
})
