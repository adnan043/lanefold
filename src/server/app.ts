import {Hono} from 'hono';
import {bodyLimit} from 'hono/body-limit';

import {isPreview} from '../platform/api';
import {adminRoutes, authRoutes, getAccess, getViewer} from '../platform/auth';
import {config} from '../platform/config';
import {csrf, previewCookies, problem, sameOrigin} from '../platform/guards';
import {syncPermissions} from '../platform/permission-sync';
import {devFileRoutes} from './files';
import {authSettings} from './auth-settings';
import {billingRoutes} from './routes/billing';
import {brandingRoutes} from './routes/branding';
import {checkoutRoutes, membershipRoutes} from './routes/checkout';
import {abilitiesFor, CATALOGUE} from './permissions';
import {accountPreflightRoutes} from './routes/account-preflight';
import {boardRoutes} from './routes/boards';
import {boardBackgroundRoutes} from './routes/board-background';
import {laneActionRoutes} from './routes/lane-actions';
import {boardExtraRoutes} from './routes/board-extras';
import {cardDetailRoutes} from './routes/card-detail';
import {cardTemplateRoutes} from './routes/card-templates';
import {cardFieldRoutes} from './routes/card-fields';
import {cardRecurrenceRoutes} from './routes/card-recurrence';
import {cardMoveBoardRoutes} from './routes/card-move-board';
import {boardWorkloadRoutes} from './routes/board-workload';
import {cardBulkRoutes} from './routes/card-bulk';
import {chatRoutes} from './routes/chat';
import {chatExtraRoutes} from './routes/chat-extras';
import {memberRoutes} from './routes/members';
import {workspaceSettingsRoutes} from './routes/workspace-settings';
import {workspaceAuditRoutes} from './routes/workspace-audit';
import {morningDigestRoutes} from './routes/morning-digest';
import {notificationEmailRoutes} from './routes/notification-email';
import {notificationRoutes} from './routes/notifications';
import {savedFilterRoutes} from './routes/saved-filters';
import {importExportRoutes} from './routes/import-export';
import {searchRoutes} from './routes/search';
import {siteRoutes} from './routes/site';
import {boardShareRoutes} from './routes/board-share';
import {boardStaleRoutes} from './routes/board-stale';
import {boardPeopleRoutes} from './routes/board-people';
import {boardMemberRoutes} from './routes/board-members';
import {flowRoutes} from './routes/flows';
import {publicBoardRoutes} from './routes/public-board';

/**
 * The Site API: this site's ONLY backend, one Hono app at `/site-api/*`.
 *
 * Everything reads and writes through it: the Astro pages call it IN-PROCESS
 * (`src/server/backend.ts`), the portal and the `/account` pages call it from
 * the browser (`siteFetch` / the typed `hc` client, `src/portal/api.ts`).
 * Mounted by ONE catch-all page, `src/pages/site-api/[...path].ts`.
 *
 *   GET  /health        what this site has been given (booleans only)
 *   GET  /me            the visitor + what the UI may show them
 *   *    /auth/...      sign-up, sign-in, sessions, passwords   platform/auth/routes.ts
 *   *    /admin/...     users, roles, audit log (admins)        platform/auth/admin.ts
 *   GET  /site          the site's brand                        routes/site.ts
 *   GET  /brand.css     the brand colour's accent tokens        routes/branding.ts
 *   *    /checkout/...  start and confirm a payment             routes/checkout.ts
 *   *    /memberships/... the member's memberships               routes/checkout.ts
 *
 * Add a feature as a new `routes/<name>.ts` and one `.route()` line below,
 * CHAINED so `AppType` carries every route to the typed client. Errors are
 * JSON `{error, message}`. `sameOrigin` + `csrf` refuse every cross-site or
 * token-less write; keep them, with `previewCookies` before them (a webhook
 * that must accept a cross-site write gets its own app, mounted before them,
 * with its own authentication).
 */
export const app = new Hono()
  .basePath('/site-api')
  // The editor Preview only: auth cookies carried in headers (its gateway drops cookies).
  .use(previewCookies)
  .use(sameOrigin)
  // The Buy button posts here as a plain form too (no JavaScript): BEFORE `csrf`, with its own
  // `formCsrf` (the token, or a same-origin form post). Keep it here (docs/agent/payments.md).
  .route('/checkout', checkoutRoutes)
  // Dev only (no Site Key on this machine): the stand-in for the platform's upload URL; refuses everything otherwise.
  .route('/dev-files', devFileRoutes)
  .use(csrf)
  // No route here takes a big body; uploads never pass through the Worker.
  .use(bodyLimit({maxSize: 64 * 1024, onError: c => c.json(problem('too_large', 'That request is too large.'), 413)}))
  // New catalogue codenames reach the `permissions` table (once per isolate; no migration).
  .use(syncPermissions(CATALOGUE))

  .get('/health', c =>
    c.json({
      ok: true,
      preview: isPreview(),
      database: Boolean(config.databaseUrl),
      auth: Boolean(config.jwtSecret && config.databaseUrl),
      siteKey: Boolean(config.siteKey),
    })
  )

  // `abilities` only decides what the UI SHOWS; every guarded route checks again.
  .get('/me', async c => {
    const [viewer, access] = await Promise.all([getViewer(c.req.raw), getAccess(c.req.raw)]);
    c.header('Cache-Control', 'private, no-store');
    // One flag per catalogue entry with an `ability` (src/server/permissions.ts).
    const abilities = abilitiesFor(new Set(access.permissions));
    return c.json({viewer, roles: access.roles, abilities});
  })

  .route('/auth', authRoutes(authSettings))
  .route('/admin', adminRoutes)
  .route('/site', siteRoutes)
  .route('/memberships', membershipRoutes)
  .route('/', boardRoutes)
  .route('/', laneActionRoutes)
  .route('/', boardExtraRoutes)
  .route('/', boardBackgroundRoutes)
  .route('/', cardDetailRoutes)
  .route('/', cardTemplateRoutes)
  .route('/', cardFieldRoutes)
  .route('/', cardRecurrenceRoutes)
  .route('/', cardMoveBoardRoutes)
  .route('/', cardBulkRoutes)
  .route('/', boardWorkloadRoutes)
  .route('/', chatRoutes)
  .route('/', chatExtraRoutes)
  .route('/', billingRoutes)
  .route('/', brandingRoutes)
  .route('/', memberRoutes)
  .route('/', workspaceSettingsRoutes)
  .route('/', workspaceAuditRoutes)
  .route('/', notificationRoutes)
  .route('/', notificationEmailRoutes)
  .route('/', morningDigestRoutes)
  .route('/', searchRoutes)
  .route('/', savedFilterRoutes)
  .route('/', importExportRoutes)
  .route('/', accountPreflightRoutes)
  .route('/', boardShareRoutes)
  .route('/', boardStaleRoutes)
  .route('/', boardPeopleRoutes)
  .route('/', boardMemberRoutes)
  .route('/', flowRoutes)
  .route('/', publicBoardRoutes)

  .notFound(c => c.json(problem('not_found', 'No such Site API route.'), 404))
  .onError((err, c) => {
    // The message only: an error object can carry request details.
    console.error(`site-api ${c.req.method} ${c.req.path}: ${err.message}`);
    return c.json(problem('internal_error', 'Something went wrong.'), 500);
  });

export type AppType = typeof app;
