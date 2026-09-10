// Minimal inline icon set (paths from Lucide, ISC license) — monochrome,
// inherits currentColor.

const paths: Record<string, string> = {
  inbox:
    'M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
  draft:
    'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z',
  send: 'm22 2-7 20-4-9-9-4Zm0 0L11 13',
  archive:
    'M20 9v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9m16-5H4a1 1 0 0 0-1 1v3a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1Zm-10 8h4',
  junk: 'm4.9 4.9 14.2 14.2M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z',
  trash:
    'M3 6h18m-2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
  folder:
    'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
  refresh:
    'M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16m0 5v-5h5',
  back: 'm12 19-7-7 7-7m7 7H5',
  paperclip:
    'm21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48',
  mail: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm18 3-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0-15v2m0 16v2M4.22 4.22l1.42 1.42m12.72 12.72 1.42 1.42M2 12h2m16 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42',
  moon: 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z',
  monitor:
    'M20 3H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2ZM8 21h8m-4-4v4',
  flag: 'M4 22V4c0-.6.4-1 1-1h9.5a1 1 0 0 1 .8 1.6L13 8l2.3 3.4a1 1 0 0 1-.8 1.6H4',
  mailUnread:
    'M22 10.5V17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h9M2 7l8.97 5.7a1.94 1.94 0 0 0 2.06 0L16 10.5M19 2v6m0 0 3-3m-3 3-3-3',
  reply: 'M9 17l-5-5 5-5m-5 5h11a4 4 0 0 1 4 4v3',
  replyAll: 'M7 17l-5-5 5-5m5 10-5-5 5-5m-2 5h7a4 4 0 0 1 4 4v3',
  forward: 'm15 17 5-5-5-5m5 5H9a4 4 0 0 0-4 4v3',
  search: 'm21 21-4.34-4.34M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z',
  compose:
    'M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7m-1.5-8.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4m4-5 5 5 5-5m-5 5V3',
  contact: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm8 10v-2a6 6 0 0 0-6-6h-4a6 6 0 0 0-6 6v2',
  calendar:
    'M8 2v4m8-4v4M3.5 9.5h17M5 5h14a1.5 1.5 0 0 1 1.5 1.5v13A1.5 1.5 0 0 1 19 21H5a1.5 1.5 0 0 1-1.5-1.5v-13A1.5 1.5 0 0 1 5 5Z',
  more: 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm7 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2ZM5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z',
  folderPlus:
    'M12 10v6m-3-3h6m5 7a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
  lock:'M7 11V7a5 5 0 0 1 10 0v4m-12 0h14a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z',
  check: 'M20 6 9 17l-5-5',
  chevronDown: 'm6 9 6 6 6-6',
  close: 'M18 6 6 18M6 6l12 12',
  bolt: 'M13 2 4.5 13.5H12l-1 8.5 8.5-11.5H12Z',
  offline:
    'm2 2 20 20M8.5 16.5a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 3.6-2.3m3.4-1.1a10 10 0 0 1 7 3.4M1.4 9.4a15 15 0 0 1 5-3.2m4-.9a15 15 0 0 1 12.2 4.1M12 20h.01',
  signOut: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m5 5H9',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a1 1 0 0 1 .2-1.1l.1-.1a1.2 1.2 0 1 0-1.7-1.7l-.1.1a1 1 0 0 1-1.1.2 1 1 0 0 1-.6-.9V8a1.2 1.2 0 1 0-2.4 0v.1a1 1 0 0 1-.6 1 1 1 0 0 1-1.1-.3l-.1-.1a1.2 1.2 0 1 0-1.7 1.7l.1.1a1 1 0 0 1 .2 1.1 1 1 0 0 1-.9.6H8a1.2 1.2 0 1 0 0 2.4h.1a1 1 0 0 1 1 .6 1 1 0 0 1-.3 1.1l-.1.1a1.2 1.2 0 1 0 1.7 1.7l.1-.1a1 1 0 0 1 1.1-.2 1 1 0 0 1 .6.9v.2a1.2 1.2 0 1 0 2.4 0v-.1a1 1 0 0 1 .6-1 1 1 0 0 1 1.1.3l.1.1a1.2 1.2 0 1 0 1.7-1.7l-.1-.1a1 1 0 0 1-.2-1.1 1 1 0 0 1 .9-.6h.2a1.2 1.2 0 1 0 0-2.4h-.1a1 1 0 0 1-1-.6Z',
  // Compose formatting toolbar (ComposeToolbar.tsx).
  bold: 'M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8',
  italic: 'M19 4 10 4M14 20 5 20M15 4 9 20',
  underline: 'M6 4v6a6 6 0 0 0 12 0V4M4 20 20 20',
  strikethrough: 'M16 4H9a3 3 0 0 0-2.83 4M14 12a4 4 0 0 1 0 8H6M4 12 20 12',
  bulletList: 'M3 5h.01M3 12h.01M3 19h.01M8 5h13M8 12h13M8 19h13',
  orderedList:
    'M11 5h10M11 12h10M11 19h10M4 4h1v5M4 9h2M6.5 20H3.4c0-1 2.6-1.925 2.6-3.5a1.5 1.5 0 0 0-2.6-1.02',
  quote: 'M17 5H3M21 12H8M21 19H8M3 12v7',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  unlink: 'M9 17H7A5 5 0 0 1 7 7M15 7h2a5 5 0 0 1 4 8M8 12 12 12M2 2 22 22',
}

export type IconName = keyof typeof paths

export function Icon({
  name,
  size = 16,
  className,
}: {
  name: IconName
  size?: number
  className?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      <path d={paths[name] ?? paths['folder']!} />
    </svg>
  )
}
