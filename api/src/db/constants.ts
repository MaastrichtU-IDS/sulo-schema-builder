/**
 * Owner of the schemas that predate authentication (migration 002 seeds both
 * the users row and their ownership). Nothing creates schemas under it any
 * more — modules/schemas/routes.ts keys on `request.user.id` — and no token can
 * ever resolve to it, because modules/users/service.ts refuses its reserved
 * subject `'local'`. Still used by the service-layer tests, which need an owner
 * but no session.
 */
export const LOCAL_OWNER_ID = '00000000-0000-0000-0000-000000000001';
