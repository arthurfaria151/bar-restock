# Bar Restock redesign

A visual and UX redesign inspired by Apple.com's design principles: big confident headlines, lots of
whitespace, a translucent sticky top bar, pill buttons, quiet greys and one blue accent, with a full
dark mode. No Apple logos, images or trademarked assets are used.

Business logic, storage keys, data shapes, roles and the service worker strategy are unchanged.
See [audit.md](audit.md) for the pre-redesign map of the app.

## Run it

There is no build step.

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Default PINs are listed in the comment above `ROLES` in `app.js`.

## Design tokens

All tokens live at the top of `styles.css` on `:root`, with dark values in a
`@media (prefers-color-scheme: dark)` block. Nothing below that block uses a raw colour.

| Group | Tokens | Values (light → dark) |
|---|---|---|
| Font | `--font` | `-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Inter", …` |
| Type scale | `--fs-hero` `--fs-h2` `--fs-h3` `--fs-body` `--fs-small` `--fs-micro` | hero `clamp(40px → 72px)`, h2 24→32px, h3 21px, body 17px, 14px, 12px |
| Type style | `--lh-body` `--lh-tight` `--ls-hero` `--fw-semibold` `--fw-bold` | 1.5, 1.07, −0.025em, 600, 700 |
| Background | `--bg` `--bg-alt` | `#fff` / `#f5f5f7` → `#000` / `#101012` |
| Surface | `--surface` `--surface-sunken` | `#fff` / `#f5f5f7` → `#1d1d1f` / `#2c2c2e` |
| Text | `--text` `--text-2` `--text-3` | `#1d1d1f` / `#6e6e73` / `#86868b` → `#f5f5f7` / `#a1a1a6` / `#86868b` |
| Accent | `--accent` `--accent-hover` `--accent-text` `--on-accent` | `#0071e3`, `#0077ed`, `#0066cc` → `#2997ff` (text), white |
| Status | `--danger` `--warn-bg` `--warn-text` | `#d70015`, `#fff4e5`, `#8a4b00` → `#ff453a`, `#2b1f0e`, `#ffb340` |
| Lines & effects | `--separator` `--nav-bg` `--focus` `--shadow` `--skeleton*` | hairlines at 10–14% alpha, nav at 72% alpha + blur(20px) |
| Space (8px scale) | `--s-1` … `--s-9` | 4, 8, 12, 16, 24, 32, 48, 64, 96px |
| Layout | `--section-y` `--gutter` `--max` `--nav-h` | section padding 48 → 64 → 96px (phone → tablet → desktop), gutter 16 → 24px, max width 1080px, nav 52px |
| Shape | `--r-card` `--r-inner` `--r-pill` `--tap` | 18px, 12px, pill, 44px minimum target |
| Motion | `--ease` `--t-fast` `--t-slow` | ease-out curve, 200ms, 400ms |

### Contrast (WCAG AA)

Body text `#1d1d1f` on white is 16.8:1. Secondary text `#6e6e73` is 5.0:1 on white and 4.6:1 on
`#f5f5f7`. Accent text `#0066cc` is 5.6:1 on white; white on the `#0071e3` button is 4.7:1. The
warning text `#8a4b00` on `#fff4e5` is 6.3:1. In dark mode, `#a1a1a6` on `#1d1d1f` is 6.5:1,
`#2997ff` on black is 7.0:1 and `#ff453a` on `#1d1d1f` is 4.9:1. `--text-3` (`#86868b`) is used only for placeholders,
disabled controls and decorative icons.

## Components

| Component | Classes | Notes |
|---|---|---|
| Top bar | `.app-header` `.nav-inner` `.brand` `.badge` | Sticky, translucent, `backdrop-filter: blur(20px)`; units badge on the right |
| Section links | `.tab-bar` `.tab-btn` `.tab-badge` | Text links on ≥768px; a full-width menu sheet with icons on phones |
| Mobile menu | `.menu-toggle` `.nav-menu` `.menu-open` | `aria-expanded`, closes on link tap and Escape |
| Hero | `.hero` `.hero-title` `.hero-sub` `.hero-actions` | One headline, one subline, one to three pill buttons per screen |
| Section | `.section` `.section-title` `.list-toolbar` `.summary` | Centred at 1080px max width |
| Buttons | `.btn` + `-primary` `-secondary` `-ghost` `-danger` `-sm` `-block`, `.icon-btn` | Pill-shaped, 44px minimum height |
| Card | `.card` `.card-title` | 18px radius, hairline ring, almost no shadow |
| Form field | `.field` `.field-label` `.input` `.field-error` | 52px inputs, visible labels, inline error under the field |
| Product card | `.product-card` `.selected-dot` | Blue ring and count bubble when selected |
| Stepper | `.qty-row` `.qty-btn` `.qty-val` | Pill track with round 44px − / + buttons |
| Grouped list | `.restock-list` `.restock-item` `.stock-item` `.low-tag` | One surface with hairline dividers, no per-row borders |
| Banner | `.low-banner` | Calm amber notice with icon, action and dismiss |
| States | `.empty-state` (`.is-error`), `.skeleton-card`, `.skeleton-row` | Icon + title + hint + action; shimmer skeletons while the catalog loads |
| Toast | `.toast` | Dark pill, inverted in dark mode |
| Icons | `<symbol id="i-*">` in `index.html` | 14 Lucide-style 24px line icons (2px stroke), drawn inline; replace the old emoji |
| Motion | `.reveal` / `.in` | Fade + 16px slide, 400ms, triggered by `IntersectionObserver`; off under `prefers-reduced-motion` |

## What changed per screen

| Screen | Before | After |
|---|---|---|
| Sign in | Dark card, small caps label, browser-native validation | Hero headline, white card, labelled role group and PIN field, inline messages for "Choose a role", "Enter your PIN", "Wrong PIN" |
| Products | Edge-to-edge dark grid, no heading | Hero ("Build tonight's restock.") with *Review list* and *Count stock*; category headings; light cards with photo, blue selection ring, pill stepper; skeleton grid while loading |
| Stock | Sticky add form, one card per row, red Delete outline | Hero with *Add a product* (scrolls to and focuses the form) and *Open restock list*; labelled add-product card with inline validation; grouped list with hairline dividers, pill stepper, trash-icon Delete; skeleton rows while loading |
| Par | Help paragraph and plain list | Hero carrying the help text, *Back to stock*; same grouped list as Stock |
| Restock | Sticky action bar, plain list | Hero with *Copy list*, *Share*, *Clear*; grouped list; empty state with a cart icon and *Browse products* |
| Chrome | Bottom emoji tab bar, dark header, red banner | Translucent top bar with text links (menu on phones), line icons, amber low-stock banner, skip link, focus rings |
| Error | Plain text + Retry | Icon, title, hint and a primary *Retry* pill |

## Verification

- **Build / tests / lint:** the project has none. `node --check app.js sw.js` passes.
- **Click-through:** every screen in the audit list, in light and dark, at 375, 768, 1024 and
  1440px, via a headless-Chrome script that signs in, seeds sample data and switches tabs. No
  horizontal overflow at any width. Screenshots: `screenshots/before/` (old UI, 375 and 1440) and
  `screenshots/after/` (`<screen>-<width>-<scheme>.png`).
- **Behaviour checks (375px):** role/PIN validation messages, sign-in, menu open/close and
  `aria-expanded`, tab switching from the menu, add-product duplicate/empty/success, hero shortcuts,
  product select and increment, header badge, Retry after a simulated network failure, keyboard Tab
  focus ring in the menu. No visible control under 44px tall.

## Decisions on ambiguous points

- **Navigation on phones.** The brief asks for a top bar with a clean mobile menu, so the old bottom
  tab bar is gone and phones open sections from a menu. This adds one tap to switch sections; if
  staff miss the bottom bar it can come back as a phone-only variant using the same tokens.
- **Hero on every screen.** Kept short so lists still start within the first screen on a phone.
  Restock's hero carries its real actions (Copy / Share / Clear) instead of decorative buttons.
- **No sections per "idea" inside lists.** Each screen is one hero plus one content section; the
  category groups act as sub-sections.
- **Scroll reveal is limited to heroes and the sign-in card.** Animating 68 product cards on every
  re-render would be noisy and slow.
- **Icons are inline SVG, not a package.** Keeps the app dependency-free; the shapes follow Lucide
  (ISC licence).
- **Commits are by file** (stylesheet, markup, wiring, docs) rather than by screen, because each
  screen's change spans all three files.

## Small behaviour changes (UI only)

- Add-product errors now appear under the field and the typed name is kept, instead of a toast and
  a cleared field. `addCustomProduct` returns the message instead of calling `showToast`.
- Empty PIN shows "Enter your PIN." instead of "Wrong PIN for that role."
- Stock and Par show skeleton rows until the catalog finishes loading (new `state.loading` flag).
- The service worker cache name is bumped to `bar-restock-v7` so installed apps drop the old CSS.
- `manifest.webmanifest` theme and background colours are white to match the light theme.

## Known gaps

- Real devices were not tested; the iPhone/iPad simulator was used for earlier changes, the
  redesign was checked in headless Chrome and the in-app browser.
- The manifest has one `theme_color`; the standalone status bar follows light mode in dark mode
  until iOS reads the `<meta name="theme-color" media=…>` pair.
- Product photos are white-background JPGs, so they read as white tiles in dark mode.
- No automated test suite exists to guard the redesign.
