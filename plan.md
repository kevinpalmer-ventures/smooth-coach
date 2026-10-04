# Smooth Coach — Implementation Plan

## Product intent
Smooth Coach turns the supplied 10-Day Green Smoothie Cleanse document into a calm, practical daily companion. It keeps the source recipes, serving guidance, snacks, water target, and food-avoidance list accessible while helping a user orient to one day at a time.

## Scope
- A **Today** experience with the active recipe, four ordered routine actions, water tracking, a day reflection, source-aligned snack suggestions, and a next-day preview.
- A 10-day program map, recipe library, phase-based preparation list, and progress overview.
- Two source-derived routine shapes: three smoothies, or breakfast/lunch smoothies plus a healthy dinner.
- Browser notification opt-in for open-tab coaching nudges; it is clearly described as an in-app/open-tab feature rather than a guaranteed background reminder.
- Local browser storage for the selected day, completion state, water, reflection, plan shape, and reminder preference. No account, database, or health data transmission.
- A clear medical/safety context explaining that this is an organizer for a supplied source, not medical advice, and deliberately not operationalizing the source's colon-cleansing/bowel-movement instruction.

## Design direction — Soft Orchard Ritual
- **Design movement:** Quiet modern wellness editorial with the softness of a paper journal and the clarity of a structured coach.
- **Core principles:** reduce choices; make the next action obvious; present progress without pressure; use source details only where useful.
- **Color philosophy:** muted sage creates steadiness, peach offers a gentle reward cue, and warm cream keeps long recipe text approachable. Deep forest is reserved for hierarchy and actions.
- **Layout paradigm:** a slim desktop rail leads into a layered, asymmetrical daily canvas; on mobile the rail collapses into a compact horizontal navigation while the active action stays first.
- **Signature elements:** a round “today” progress dial, soft stacked cards with botanical corner shapes, and small ritual markers for preparation, sipping, water, and reflection.
- **Interaction philosophy:** every interaction has a visible immediate result—checkboxes advance progress, water droplets fill, and a selected program day becomes the active guide.
- **Animation:** short 180–260ms ease-out transitions for cards, toggles, and progress fills; no continuous motion and reduced-motion support.
- **Typography:** Nunito Sans for friendly, legible UI hierarchy; a Georgia editorial fallback is used for recipe names and reflective prompts.
- **Brand essence:** A gentle source-based day planner for a 10-day smoothie routine that turns a long document into the next useful action. **Personality:** compassionate, grounded, clear.
- **Brand voice:** warm and specific, never prescriptive. Examples: “Make the day easier before it starts.” and “Small check-ins count—notice what you need.”
- **Wordmark and logo:** a simple leaf-in-a-circle mark paired with the “Smooth Coach” wordmark; the mark becomes the compact mobile identifier.
- **Signature brand color:** Orchard Sage `#789B7B`.

## Architecture
A static React + TypeScript + Vite application is sufficient. Source recipes live in `src/data/cleanseData.ts`; `src/App.tsx` renders view-specific coaching content and manages local browser persistence; `src/styles.css` owns the responsive visual system; `public/manus-routes.json` declares the single application route. The site is built as a static output and needs no server, database, or external API.

## Project structure
| Path | Responsibility |
| --- | --- |
| `src/data/cleanseData.ts` | Faithful recipe, preparation, snack, and source-guidance content. |
| `src/App.tsx` | App shell, state, daily coach, program, recipes, prep, and progress experiences. |
| `src/styles.css` | Soft Orchard Ritual tokens, layouts, responsive behavior, and accessible states. |
| `src/main.tsx` | React entry point. |
| `public/manus-routes.json` | Declares the web route set. |
| `public/leaf-mark.svg` | Small botanical mark used for favicon/logo treatment. |

## Material constraints
The health-related source is displayed as user-supplied material. The interface distinguishes source claims from medical instruction, adds a concise safety notice, and avoids giving operational colon-cleansing or bowel-movement advice.
