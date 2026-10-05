# Smooth Coach — Implementation Plan

## Product intent
Smooth Coach turns the supplied 10-Day Green Smoothie Cleanse document into a calm, practical daily companion. It keeps the source recipes, serving guidance, snacks, water target, and food-avoidance list accessible while helping a user orient to one day at a time. It now adds a personal account area, a private weight timeline, and a private progression-photo timeline for users who choose to sign in.

## Scope
- A **Today** experience with the active recipe, four ordered routine actions, water tracking, a day reflection, source-aligned snack suggestions, and a next-day preview.
- A 10-day program map, recipe library, phase-based preparation list, and progress overview.
- Two source-derived routine shapes: three smoothies, or breakfast/lunch smoothies plus a healthy dinner.
- Browser notification opt-in for open-tab coaching nudges; it is clearly described as an in-app/open-tab feature rather than a guaranteed background reminder.
- Sign-in with Google or any OpenID Connect provider, with an authenticated application session. Signed-in users have their coaching check-ins stored under their account; a logged-out visitor can still read the source guide.
- A private weight tracker for signed-in users: add or update one weight per date, choose lb or kg on the first entry, see a chronological chart, the latest logged weight, and change from the first entry. Weight data is always queried and written only for the authenticated account.
- A private progression-photo timeline for signed-in users: upload a JPEG, PNG, or WebP image up to 8 MB, choose its date, and optionally add a short caption. The browser sends the picture to the server, which checks its file signature, stores it in the private Garage bucket, and serves it back only to that account through an authenticated image route.
- A clear medical/safety context explaining that this is an organizer for a supplied source, not medical advice, and deliberately not operationalizing the source's colon-cleansing/bowel-movement instruction.

## Design direction — Soft Orchard Ritual
- **Design movement:** Quiet modern wellness editorial with the softness of a paper journal and the clarity of a structured coach.
- **Core principles:** reduce choices; make the next action obvious; present progress without pressure; use source details only where useful.
- **Color philosophy:** muted sage creates steadiness, peach offers a gentle reward cue, and warm cream keeps long recipe text approachable. Deep forest is reserved for hierarchy and actions.
- **Layout paradigm:** a slim desktop rail leads into a layered, asymmetrical daily canvas; on mobile the rail collapses into a compact horizontal navigation while the active action stays first.
- **Signature elements:** a round “today” progress dial, soft stacked cards with botanical corner shapes, and small ritual markers for preparation, sipping, water, reflection, private progress, and photo moments.
- **Interaction philosophy:** every interaction has a visible immediate result—checkboxes advance progress, water droplets fill, account status is clear, a weight entry updates the personal timeline, and an uploaded image appears in the private visual timeline.
- **Animation:** short 180–260ms ease-out transitions for cards, toggles, and progress fills; no continuous motion and reduced-motion support.
- **Typography:** Nunito Sans for friendly, legible UI hierarchy; a Georgia editorial fallback is used for recipe names and reflective prompts.
- **Brand essence:** A gentle source-based day planner for a 10-day smoothie routine that turns a long document into the next useful action. **Personality:** compassionate, grounded, clear.
- **Brand voice:** warm and specific, never prescriptive. Examples: “Make the day easier before it starts.” and “Small check-ins count—notice what you need.”
- **Wordmark and logo:** a simple leaf-in-a-circle mark paired with the “Smooth Coach” wordmark; the mark becomes the compact mobile identifier.
- **Signature brand color:** Orchard Sage `#789B7B`.

## Architecture
React + TypeScript + Vite provide the browser experience. An Express server hosts the Vite development middleware and production static bundle, exposes authenticated APIs, and signs users in through any OpenID Connect provider (Google by default) using `openid-client` with PKCE, state, nonce, and verified ID-token signatures. A PostgreSQL 14+ database (via the `pg` driver and `DATABASE_URL`) holds `user_profiles`, `user_coach_state`, `weight_entries`, and `progress_photos`; a self-hosted Garage bucket on the internal Docker network holds the private photo bytes, which only ever pass through the app server. Account sessions use the `smooth_coach_session` cookie (HS256 JWT, `HttpOnly`, `Secure`, `SameSite=Lax`), and every database query is scoped to the account ID (`issuer|subject`) stored in `open_id`. At startup the server validates its configuration, applies the idempotent, additive `deploy/postgres/smooth-coach-schema.sql` under an advisory lock, loads the sign-in provider's configuration, and checks the photo bucket; no destructive database operation is used.

## Project structure
| Path | Responsibility |
| --- | --- |
| `src/cleanseData.ts` | Faithful recipe, preparation, snack, and source-guidance content. |
| `src/App.tsx` | App shell, account state, coaching workflow, local fallback, and account syncing. |
| `src/WeightTracker.tsx` | Account-scoped weight entry, summary, and visual timeline. |
| `src/ProgressPhotos.tsx` | Account-scoped picture upload form and dated visual timeline. |
| `src/types.ts` | Shared client models for coaching state, account identity, weight records, and progress photos. |
| `server/index.mjs` | Startup sequence, coaching, weight, and private photo APIs, and static/dev serving. |
| `server/config.mjs` | Environment validation that names missing or invalid settings without printing values. |
| `server/auth.mjs` | OpenID Connect sign-in and the application session cookie. |
| `server/db.mjs` | PostgreSQL pool and startup schema application. |
| `server/photoStorage.mjs` | Private S3-compatible photo storage and image signature checks. |
| `docker-compose.yml` | Self-hosted deployment: app, Garage, and Garage setup. |
| `deploy/garage/` | Garage configuration and idempotent setup script. |
| `src/styles.css` | Soft Orchard Ritual tokens, layouts, responsive behavior, and accessible states. |
| `Dockerfile` | Production container build for the server-backed site. |

## Material constraints
The health-related source is displayed as user-supplied material. The interface distinguishes source claims from medical instruction, adds a concise safety note, and avoids giving operational colon-cleansing or bowel-movement advice. Weight and progression photos are personal health information: each is private to the signed-in user, is never included in public pages, and is described as a simple self-record rather than a clinical assessment.
