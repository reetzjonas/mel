/**
 * The count on the installed app's icon (Badging API).
 *
 * Not supported everywhere (Firefox and iOS Safari have nothing), and a
 * browser that does have it still rejects while mel is an ordinary tab rather
 * than an installed app. Neither is worth reporting to anyone, so both are
 * ignored — a badge is an extra, never something the app depends on.
 *
 * Works in a service worker too: `navigator` there carries the same two
 * methods, which is what lets a push keep the icon current with the app shut.
 */
export function showAppBadge(count?: number): void {
  if (!('setAppBadge' in navigator)) return
  void navigator.setAppBadge(count).catch(() => {})
}

export function clearAppBadge(): void {
  if (!('clearAppBadge' in navigator)) return
  void navigator.clearAppBadge().catch(() => {})
}
