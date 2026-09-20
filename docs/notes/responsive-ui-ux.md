# Responsive UI and UX concept

mel should feel intentionally designed for the available space rather than like
the desktop interface compressed onto a phone. The information architecture and
terminology stay the same on every device, while navigation, density and action
placement adapt to the room each surface has.

## Layout modes

### Compact

Phones show one level at a time. The five applications live in the bottom
navigation; Settings is a utility and belongs in the top app bar instead of
becoming a crowded sixth destination. Lists and details replace one another,
with an explicit Back control in every detail. Editors, previews and settings
use the full viewport. A screen exposes one primary action, a small number of
secondary actions, and puts the rest in a menu or bottom sheet.

### Medium

Tablets and narrow windows use two panes only when both can retain a useful
minimum width. Folder and calendar collections move into drawers. Portrait and
landscape may therefore use different arrangements without changing the task
model.

### Expanded

Desktop keeps the information-rich layouts: three panes for mail, master/detail
for contacts and notes, an optional file preview, and the calendar sidebar.
Resizable widths remain device-local. Labels appear beside toolbar icons when
the containing pane, not merely the viewport, is wide enough.

These modes should be selected from content constraints and container queries
where possible. Viewport breakpoints remain appropriate for the outer shell.

## Shared application frame

Every application follows the same hierarchy:

1. global application navigation;
2. a contextual header containing location, search, the primary action and an
   overflow action;
3. the working area;
4. transient feedback for syncing, saving, errors and undo.

On compact screens the app header identifies the active application and exposes
Settings. The bottom bar contains Mail, Calendar, Contacts, Files and Notes,
subject to server capabilities. It stays visible, honours safe areas and does
not disappear while scrolling.

## Master/detail behaviour

Mail, Contacts, Files and Notes use one common rule. Compact layouts swap list
and detail, preserve the list's filter and scroll position, and make browser
Back agree with the visible Back control. Expanded layouts open the detail next
to the list. Reading surfaces receive a sensible maximum line length instead of
stretching text across unused desktop space.

## Actions and input

- Touch targets are at least 44 by 44 CSS pixels on compact layouts.
- One action is visually primary on a screen.
- No essential action depends on hover, swipe, long press or drag and drop.
- Compact toolbars may scroll horizontally only for familiar editor commands;
  task actions should move into a labelled menu or sheet when they do not fit.
- Selection mode replaces the normal toolbar and keeps destructive actions
  visually separate.
- Desktop hover and keyboard shortcuts accelerate visible functionality rather
  than providing exclusive functionality.

## Application-specific behaviour

### Mail

Compact mail exposes the current folder and folder drawer in the list header.
The message is a full-screen detail with Back, common message actions and an
overflow path for the remainder. Compose is full-screen. Expanded mail keeps
the resizable folder, message and reading panes; message content is constrained
to a readable measure.

### Calendar

Compact calendar is an agenda whose range can be month, week or day. Calendar
visibility, search and upcoming items live in a drawer. Dragging is optional;
the event dialog provides every move and edit operation. Expanded layouts keep
the month and time grids and persistent sidebar.

### Contacts

Compact contact cards are full-screen and prioritise writing, calling and
editing. Delete belongs with secondary actions. Expanded cards remain beside
the list and group their fields within a readable content width.

### Files

Compact files keep the current folder prominent, allow search to take a full
row, and wrap or scroll actions without clipping. Preview is full-screen.
Expanded files retain an optional resizable preview and drag-and-drop, with
menus and dialogs as accessible alternatives.

### Notes

Compact notes swap list and editor. The editor has explicit Back navigation and
a single-row, horizontally scrollable formatting toolbar. Metadata remains
available without reducing the writing area. Expanded layouts keep list and
editor side by side.

### Settings

Settings fills the compact viewport and remains a fixed-size modal with a side
rail on desktop. Its URL-backed tabs, section anchors and browser-Back behaviour
remain unchanged.

## Visual and accessibility rules

The existing OKLCH tokens, elevation ladder, focus treatment and reduced-motion
fallback remain the foundation. Shared header heights, spacing and typography
replace feature-specific approximations. State is never conveyed by colour
alone.

All layouts must support keyboard operation, a logical focus order, focus
return from overlays, WCAG AA contrast, 200% zoom and reduced motion. Menus,
tabs, drawers and separators follow their corresponding ARIA patterns.

## Delivery order

1. responsive shell and compact app header;
2. shared control sizing and master/detail navigation;
3. compact toolbars for Files, Calendar, Mail and Notes;
4. readable detail widths and consistent contextual headers;
5. dedicated overflow menus and drawers where wrapping is still necessary;
6. regression coverage at 320, 375, 768, 1024, 1440 and 1920 pixels, in both
   themes and with touch, mouse, keyboard and 200% zoom.

## Acceptance criteria

- No page scrolls horizontally at 320 CSS pixels.
- Primary actions are never clipped.
- Every task works without hover, swipe or drag and drop.
- Compact layouts show one navigation level at a time.
- List state survives opening and closing a detail.
- Desktop uses additional room without producing excessively long text lines.
- Frequent tasks require at most one additional step compared with their
  expanded-layout equivalent.
