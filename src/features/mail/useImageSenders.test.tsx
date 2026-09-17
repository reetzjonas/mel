import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it } from 'vitest'
import { db } from '../../storage/db'
import { sealPlain } from '../../storage/envelope'
import { setImageSender } from '../../services/imageSenders'
import { useImageSenders } from './useImageSenders'

beforeEach(async () => {
  await db.imageSenders.clear()
  await db.accounts.clear()
  for (const id of ['a', 'b']) {
    await db.accounts.put({
      id,
      provider: 'jmap',
      encrypted: false,
      payload: sealPlain({} as never),
    })
  }
})

it('reacts to permission changes and never exposes the previous account on a switch', async () => {
  await setImageSender('a', 'sender@example.com', true)
  const { result, rerender, unmount } = renderHook(({ id }) => useImageSenders(id), {
    initialProps: { id: 'a' as string | undefined },
  })
  // Unknown until read: a caller must be able to tell that apart from "none
  // allowed", or it renders a decision it has not made yet.
  expect(result.current).toBeUndefined()
  await waitFor(() => expect(result.current).toEqual(['sender@example.com']))
  rerender({ id: 'b' })
  expect(result.current).toBeUndefined()
  await act(async () => {
    await setImageSender('b', 'other@example.com', true)
  })
  await waitFor(() => expect(result.current).toEqual(['other@example.com']))
  await act(async () => {
    await setImageSender('b', 'other@example.com', false)
  })
  await waitFor(() => expect(result.current).toEqual([]))
  rerender({ id: undefined })
  expect(result.current).toBeUndefined()
  await waitFor(() => expect(result.current).toEqual([]))
  unmount()
})
