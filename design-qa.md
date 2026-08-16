# Responsive UI design QA

## Comparison target

- Source visual truth: `artifacts/ui-qa/source-iphone16pro.png`
- Primary implementation evidence: `artifacts/ui-qa/iphone16pro-keyboard-modal.png`
- Combined comparison: `artifacts/ui-qa/mobile-height-comparison.png`
- Additional evidence:
  - `artifacts/ui-qa/iphone16pro-dashboard.png`
  - `artifacts/ui-qa/iphone16pro-question-modal.png`
  - `artifacts/ui-qa/iphone16pro-question-modal-scrolled.png`
  - `artifacts/ui-qa/ipadpro11-portrait-question-modal.png`
  - `artifacts/ui-qa/ipadpro11-landscape-question-modal.png`
  - `artifacts/ui-qa/macbookair13-subject-modal.png`

The supplied screenshot is the failing state rather than a target to copy exactly. The requested visual change is to remove the unused full-height modal area while preserving the existing Obsidian/MIA visual language.

## Viewports and normalization

| Environment | CSS viewport | Screenshot pixels | Density / normalization | State |
| --- | ---: | ---: | --- | --- |
| iPhone 16 Pro | 402 × 874 | 402 × 874 | Browser DPR 1; equivalent to the supplied 1206 × 2622 @3x capture | Dashboard with compact subject editor |
| iPhone 16 Pro, keyboard visible | 402 × 539 | 402 × 539 | Supplied screenshot clipped to its top 1617 physical pixels and normalized by 3 to 402 × 539 | Subject editor above keyboard |
| iPhone 16 Pro, long form | 402 × 539 | 402 × 539 | Browser DPR 1 | Question editor, top and scrolled-to-save states |
| iPad Pro 11-inch portrait | 834 × 1194 | 834 × 1194 | Browser DPR 1 | Long question editor |
| iPad Pro 11-inch landscape | 1194 × 834 | 1194 × 834 | Browser DPR 1 | Long question editor |
| MacBook Air 13-inch | 1440 × 900 | 1440 × 900 | Browser DPR 1 | Compact subject editor |

## Findings and comparison history

### Iteration 1 — blocked

- **P1 · Compact phone modal consumed the full visible height.** In the supplied iPhone capture, a one-field subject form filled the entire region above the software keyboard and left a large empty area. The modal inherited a tall app-sheet height while only its maximum height was constrained.
  - Fix: added explicit `height: auto`, `min-height: 0`, content-sized flex behavior, and bottom alignment for keyboard-open phone modals.
- **P2 · One sizing rule treated all editors as equally tall.** A one-field subject form and the multi-field question form shared the same modal geometry.
  - Fix: introduced compact, medium, and long editor size variants. Long forms are capped and scroll internally; short forms remain content-sized.
- **P2 · Phone primary action width was theme-dependent.** The save action could become narrower in some theme/base-style combinations.
  - Fix: the final action in a phone editor now spans the available width while retaining the 44px touch target.

### Iteration 2 — passed

- The compact iPhone modal measures 386 × 243 CSS pixels and sits 8px above the visible viewport edge; the 402 × 539 viewport has no horizontal overflow.
- The long iPhone question editor measures 386 × 523 CSS pixels. Its content scrolls from 470px visible height to 1103px total height, and the save action is visible after scrolling to the bottom.
- iPad portrait uses a 760px modal inside 834px width with no horizontal overflow. Landscape remains within 1194 × 834 and scrolls only the form content when needed.
- The MacBook Air compact modal is centered at 440 × 212.5 CSS pixels inside 1440 × 900, without excess height.
- No browser console warnings or errors were recorded.

## Fidelity surfaces

- **Fonts and typography:** production typography remains inherited from Obsidian; no font family, weight, line-height, wrapping, or label hierarchy was changed. Text remains legible at all checked sizes.
- **Spacing and layout rhythm:** compact forms now use natural content height; long forms use bounded internal scrolling. Phone edges keep 8px clearance, tablets retain 24px minimum side clearance, and desktop uses a 440px compact width.
- **Colors and visual tokens:** all production colors, borders, radii, shadows, and accent states continue to use existing Obsidian variables. The QA harness only supplies stand-in values so those tokens can render outside Obsidian.
- **Image quality and assets:** the tested UI contains no product imagery. No production icons or assets were replaced.
- **Copy and content:** production labels and form content are unchanged.

## Interaction and accessibility checks

- Verified the long phone form scrolls to the final save action without scrolling the background page.
- Verified 44px phone touch targets remain in force.
- Verified no horizontal overflow at 402px, 834px, 1194px, or 1440px.
- Verified the compact modal no longer covers the complete keyboard-visible region.
- Screenshot evidence cannot prove screen-reader announcements or physical iOS keyboard focus behavior; those remain device-runtime checks.

## Focused comparison evidence

The combined mobile comparison shows the same keyboard-visible 402 × 539 content region before and after the fix. A separate focused crop was unnecessary because the title, label, input, divider, and save action are all readable at normalized 1:1 CSS size.

## Implementation checklist

- [x] Content-size compact editors.
- [x] Cap and internally scroll long editors.
- [x] Preserve mobile touch sizing and full-width save action.
- [x] Validate iPhone 16 Pro, iPad Pro 11-inch portrait/landscape, and MacBook Air 13-inch viewports.
- [x] Run unit tests and production build.

final result: passed
