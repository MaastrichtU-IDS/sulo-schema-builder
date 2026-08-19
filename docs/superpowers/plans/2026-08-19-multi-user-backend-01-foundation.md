# Multi-user Backend — Plan 1: Foundation (Postgres, no auth yet)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-visitor browser storage with a Postgres-backed schema store that reaches feature parity with today's SQLite REST API, behind a shared `@sulo/schema-core` package, with the desktop SQLite path frozen and still working.

**Architecture:** The repo becomes an npm workspace with three packages: `api`, `frontend`, and a new dependency-free `packages/schema-core` holding the OWL/SHACL generator and the shared schema types. The API gains a Postgres data path (`pg` + Kysely + SQL migrations) organised as a `modules/schemas` unit — repository, service, mappers, routes — selected by `SCHEMA_STORAGE=postgres`. Today's SQLite code moves untouched to `api/src/legacy/sqlite/` and is selected by `SCHEMA_STORAGE=sqlite`. No authentication in this plan: every schema is owned by one seeded local user row, which the next plan replaces with real users.

**Tech Stack:** Node 22, TypeScript 5.5 strict + NodeNext, Fastify 5, zod 3, Postgres 16, Kysely, `pg`, vitest 2, `@testcontainers/postgresql`, npm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-19-multi-user-backend-design.md`

## Global Constraints

- Node 22; CI runs `ubuntu-latest` with Docker available (Testcontainers depends on it).
- TypeScript `strict: true`, `module`/`moduleResolution`: `NodeNext`. **Every relative import ends in `.js`** even when the source is `.ts` — this is existing repo convention and required by NodeNext ESM.
- ESM only (`"type": "module"` in every package).
- Postgres 16 (`postgres:16-alpine`), accessed only through Kysely — no raw string interpolation into SQL.
- Migrations are plain `.sql` files in `api/migrations/`, named `NNN_description.sql`, applied in lexical order, each in its own transaction. Never edit an applied migration; add a new one.
- `SCHEMA_STORAGE` accepts exactly `postgres` or `sqlite`. The value `browser` is removed in Task 1 and must not reappear.
- IRI minting must stay byte-identical to today (exports embed IRIs): base `https://w3id.org/sulo/schema/`, resource prefix `${base}resource/`, then `ontology-schema/{id}`, `ontology-class/{id}`, `ontology-prop/{id}`.
- `base_uri` is normalised on write to end in `/` or `#`.
- PATCH semantics are preserved exactly: an empty string clears a nullable field; an absent key leaves it unchanged.
- The seeded owner UUID is `00000000-0000-0000-0000-000000000001` (`LOCAL_OWNER_ID`).
- Do not touch `frontend/src/pages/OntologyBuilderPage.tsx` beyond import-path changes. It is 4065 lines and out of scope.
- Do not modify `api/src/rdf/safeFetch.ts`, `services/robot.service.ts`, `services/sulo.service.ts`, or the ROBOT output parsers.
- Commit after every task. Never `git commit` outside the steps that say to.

---

### Task 1: Remove browser (IndexedDB) storage

**Files:**
- Create: `frontend/src/api/backend.test.ts`
- Create: `frontend/src/test/fakeBackend.ts`
- Delete: `frontend/src/api/localStore.ts`, `frontend/src/api/localStore.test.ts`, `frontend/src/api/appConfig.ts`, `api/src/routes/v1/appConfig.ts`
- Modify: `frontend/src/api/backend.ts`, `frontend/src/lib/schemaTransfer.test.ts:1-14`, `frontend/package.json`, `api/src/routes/v1/index.ts`, `api/src/server.ts:32-44`, `api/src/config.ts:25-31`
- Test: `frontend/src/api/backend.test.ts`, `frontend/src/lib/schemaTransfer.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `frontend/src/api/backend.ts` keeps the same exported function names and signatures it has today (`listSchemas`, `getSchema`, `createSchema`, `updateSchema`, `deleteSchema`, `addClass`, `updateClass`, `deleteClass`, `addProperty`, `updateProperty`, `deleteProperty`, `fetchUpperConcepts`, plus the re-exported `PropertyInput`/`PropertyPatch` types) but every one is REST-only. `frontend/src/test/fakeBackend.ts` exports `createFakeBackend()` returning an object with that same surface plus `reset()`.

- [ ] **Step 1: Write the failing test for a REST-only backend**

Create `frontend/src/api/backend.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
const del = vi.fn();

vi.mock('./client.js', () => ({
  apiClient: {
    get: (...args: unknown[]) => get(...args),
    post: (...args: unknown[]) => post(...args),
    patch: (...args: unknown[]) => patch(...args),
    delete: (...args: unknown[]) => del(...args),
  },
}));

const backend = await import('./backend.js');

describe('backend dispatch', () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    patch.mockReset();
    del.mockReset();
  });

  it('lists schemas over REST without consulting a storage-mode endpoint', async () => {
    get.mockResolvedValue({ data: [{ id: 'a', title: 'A' }] });

    const result = await backend.listSchemas();

    expect(result).toEqual([{ id: 'a', title: 'A' }]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/ontology-schemas');
  });

  it('creates a schema over REST', async () => {
    post.mockResolvedValue({ data: { id: 'b', title: 'B' } });

    const result = await backend.createSchema({ title: 'B' });

    expect(result).toEqual({ id: 'b', title: 'B' });
    expect(post).toHaveBeenCalledWith('/ontology-schemas', { title: 'B' });
  });

  it('fetches upper concepts through the per-schema route', async () => {
    get.mockResolvedValue({ data: [] });

    await backend.fetchUpperConcepts('sid');

    expect(get).toHaveBeenCalledWith('/ontology-schemas/sid/upper-concepts');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/api/backend.test.ts`
Expected: FAIL. Today `listSchemas` first awaits `getStorageMode()`, which issues a second `apiClient.get('/app-config')`, so `expect(get).toHaveBeenCalledTimes(1)` fails (and the mocked response shape breaks the mode read).

- [ ] **Step 3: Rewrite `backend.ts` as REST-only**

Replace the whole file `frontend/src/api/backend.ts` with:

```ts
// Every schema CRUD call goes through here to the REST API. There is exactly
// one storage backend: the server. (Browser/IndexedDB storage was removed —
// see docs/superpowers/specs/2026-08-19-multi-user-backend-design.md.)

import { apiClient } from './client.js';
import type {
  OntologyClass,
  OntologyProperty,
  OntologySchema,
  OntologySchemaSummary,
  UpperConcept,
} from './ontology.js';

export type ClassInput = {
  name: string; label?: string; description?: string;
  mapsToConceptIri?: string; superClassId?: string;
};
export type ClassPatch = Partial<ClassInput>;

export type PropertyInput = {
  name: string;
  label?: string;
  description?: string;
  propertyType: 'object' | 'datatype';
  domainClassId?: string;
  rangeClassIri?: string;
  mappingPattern?: { subject: string; predicate: string; object: string }[];
  regexPattern?: string;
  regexVariable?: string;
  isRequired?: boolean;
  propertyFeatures?: string[];
  inversePropertyIri?: string;
  disjointPropertyIris?: string[];
};
export type PropertyPatch = Partial<PropertyInput>;

export async function listSchemas(): Promise<OntologySchemaSummary[]> {
  return apiClient.get('/ontology-schemas').then((r) => r.data);
}

export async function getSchema(id: string): Promise<OntologySchema> {
  return apiClient.get(`/ontology-schemas/${id}`).then((r) => r.data);
}

export async function createSchema(data: {
  title: string; description?: string; upperOntologyIri?: string; baseUri?: string;
}): Promise<OntologySchema> {
  return apiClient.post('/ontology-schemas', data).then((r) => r.data);
}

export async function updateSchema(id: string, data: {
  title?: string; description?: string; upperOntologyIri?: string; baseUri?: string;
}): Promise<void> {
  await apiClient.patch(`/ontology-schemas/${id}`, data);
}

export async function deleteSchema(id: string): Promise<void> {
  await apiClient.delete(`/ontology-schemas/${id}`);
}

export async function addClass(schemaId: string, data: ClassInput): Promise<OntologyClass> {
  return apiClient.post(`/ontology-schemas/${schemaId}/classes`, data).then((r) => r.data);
}

export async function updateClass(schemaId: string, classId: string, data: ClassPatch): Promise<void> {
  await apiClient.patch(`/ontology-schemas/${schemaId}/classes/${classId}`, data);
}

export async function deleteClass(schemaId: string, classId: string): Promise<void> {
  await apiClient.delete(`/ontology-schemas/${schemaId}/classes/${classId}`);
}

export async function addProperty(schemaId: string, data: PropertyInput): Promise<OntologyProperty> {
  return apiClient.post(`/ontology-schemas/${schemaId}/properties`, data).then((r) => r.data);
}

export async function updateProperty(schemaId: string, propId: string, data: PropertyPatch): Promise<void> {
  await apiClient.patch(`/ontology-schemas/${schemaId}/properties/${propId}`, data);
}

export async function deleteProperty(schemaId: string, propId: string): Promise<void> {
  await apiClient.delete(`/ontology-schemas/${schemaId}/properties/${propId}`);
}

export async function fetchUpperConcepts(schemaId: string): Promise<UpperConcept[]> {
  return apiClient.get(`/ontology-schemas/${schemaId}/upper-concepts`).then((r) => r.data);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/api/backend.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the in-memory fake backend for transfer tests**

`schemaTransfer.test.ts` currently uses `localStore` both as a fixture builder and as the write target for `importSchemaExport`. Replace that role with an explicit test double. Create `frontend/src/test/fakeBackend.ts`:

```ts
// In-memory stand-in for src/api/backend.ts, used by tests that need a real
// read-after-write store (schema import, share links). Mints the same IRIs as
// the server so exports and cross-references round-trip identically.

import type {
  OntologyClass,
  OntologyProperty,
  OntologySchema,
  OntologySchemaSummary,
} from '../api/ontology.js';
import type { ClassInput, ClassPatch, PropertyInput, PropertyPatch } from '../api/backend.js';

const BASE = 'https://w3id.org/sulo/schema/';
const SHEXR = `${BASE}resource/`;
export const schemaIri = (id: string) => `${SHEXR}ontology-schema/${id}`;
export const classIri = (id: string) => `${SHEXR}ontology-class/${id}`;
export const propIri = (id: string) => `${SHEXR}ontology-prop/${id}`;

function normalizeBaseUri(uri: string): string {
  return /[/#]$/.test(uri) ? uri : `${uri}/`;
}

/** '' clears a nullable field, undefined leaves it untouched — server PATCH semantics. */
function applyPatch<T extends object>(target: T, patch: Partial<Record<keyof T, unknown>>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    (target as Record<string, unknown>)[key] = value === '' ? undefined : value;
  }
}

export function createFakeBackend() {
  const schemas = new Map<string, OntologySchema>();

  async function getSchema(id: string): Promise<OntologySchema> {
    const found = schemas.get(id);
    if (!found) throw new Error(`schema ${id} not found`);
    return {
      ...found,
      classes: [...found.classes].sort((a, b) => a.name.localeCompare(b.name)),
      properties: [...found.properties].sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  return {
    reset(): void {
      schemas.clear();
    },

    async listSchemas(): Promise<OntologySchemaSummary[]> {
      return [...schemas.values()]
        .map(({ classes: _c, properties: _p, ...summary }) => summary)
        .sort((a, b) => a.title.localeCompare(b.title));
    },

    getSchema,

    async createSchema(data: {
      title: string; description?: string; upperOntologyIri?: string; baseUri?: string;
    }): Promise<OntologySchema> {
      const id = crypto.randomUUID();
      const schema: OntologySchema = {
        id,
        url: schemaIri(id),
        title: data.title,
        description: data.description,
        upperOntologyIri: data.upperOntologyIri,
        baseUri: data.baseUri ? normalizeBaseUri(data.baseUri) : undefined,
        classes: [],
        properties: [],
      };
      schemas.set(id, schema);
      return schema;
    },

    async updateSchema(id: string, data: {
      title?: string; description?: string; upperOntologyIri?: string; baseUri?: string;
    }): Promise<void> {
      const schema = await getSchema(id);
      const stored = schemas.get(id)!;
      applyPatch(stored, { ...data, baseUri: data.baseUri ? normalizeBaseUri(data.baseUri) : data.baseUri });
      void schema;
    },

    async deleteSchema(id: string): Promise<void> {
      schemas.delete(id);
    },

    async addClass(schemaId: string, data: ClassInput): Promise<OntologyClass> {
      const stored = schemas.get(schemaId)!;
      const id = crypto.randomUUID();
      const cls: OntologyClass = { id, url: classIri(id), ...data };
      stored.classes.push(cls);
      return cls;
    },

    async updateClass(schemaId: string, classId: string, data: ClassPatch): Promise<void> {
      const cls = schemas.get(schemaId)!.classes.find((c) => c.id === classId)!;
      applyPatch(cls, data);
    },

    async deleteClass(schemaId: string, classId: string): Promise<void> {
      const stored = schemas.get(schemaId)!;
      stored.classes = stored.classes.filter((c) => c.id !== classId);
      for (const c of stored.classes) if (c.superClassId === classId) c.superClassId = undefined;
      for (const p of stored.properties) if (p.domainClassId === classId) p.domainClassId = undefined;
    },

    async addProperty(schemaId: string, data: PropertyInput): Promise<OntologyProperty> {
      const stored = schemas.get(schemaId)!;
      const id = crypto.randomUUID();
      const prop = {
        id,
        url: propIri(id),
        ...data,
        isRequired: data.isRequired ?? false,
        mappingPattern: data.mappingPattern ?? [],
        propertyFeatures: data.propertyFeatures ?? [],
        disjointPropertyIris: data.disjointPropertyIris ?? [],
      } as OntologyProperty;
      stored.properties.push(prop);
      return prop;
    },

    async updateProperty(schemaId: string, propId: string, data: PropertyPatch): Promise<void> {
      const prop = schemas.get(schemaId)!.properties.find((p) => p.id === propId)!;
      applyPatch(prop, data);
    },

    async deleteProperty(schemaId: string, propId: string): Promise<void> {
      const stored = schemas.get(schemaId)!;
      stored.properties = stored.properties.filter((p) => p.id !== propId);
    },

    async fetchUpperConcepts(): Promise<never[]> {
      return [];
    },
  };
}
```

- [ ] **Step 6: Point `schemaTransfer.test.ts` at the fake backend**

In `frontend/src/lib/schemaTransfer.test.ts`, replace lines 1–17 (the `fake-indexeddb` import, the `localStore`/`appConfig` imports, the `setStorageModeForTests` calls, and the `reset()` helper) with:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeBackend } from '../test/fakeBackend.js';

const store = createFakeBackend();
vi.mock('../api/backend.js', () => store);

import {
  serializeSchema,
  parseSchemaExport,
  importSchemaExport,
  encodeShareFragment,
  decodeShareFragment,
} from './schemaTransfer.js';

async function reset() {
  store.reset();
}
```

Leave every `describe`/`it` body, every `store.*` call, and every assertion exactly as they are — the fake exposes the same method names `localStore` did.

- [ ] **Step 7: Delete the browser-storage modules and their dependencies**

```bash
cd /home/ensar/workspace/03_ids/sulo-schema-builder-main
git rm frontend/src/api/localStore.ts frontend/src/api/localStore.test.ts frontend/src/api/appConfig.ts
git rm api/src/routes/v1/appConfig.ts
cd frontend && npm uninstall dexie fake-indexeddb
```

- [ ] **Step 8: Drop the server-side browser mode**

In `api/src/routes/v1/index.ts`, remove the `appConfigRoute` import and registration, and register the ontology routes unconditionally:

```ts
import type { FastifyPluginAsync } from 'fastify';
import healthRoute from './health.js';
import upperConceptsRoute from './upperConcepts.js';
import ontologyRoutes from './ontology.js';
import reasonRoutes from './reason.js';

const v1Routes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(healthRoute);
  await fastify.register(upperConceptsRoute);
  await fastify.register(ontologyRoutes, { prefix: '/ontology-schemas' });
  await fastify.register(reasonRoutes, { prefix: '/reason' });
};

export default v1Routes;
```

In `api/src/config.ts`, replace the `storage` block (lines 25–31) with:

```ts
// Where schema data lives. 'sqlite' is the embedded database used by the
// desktop app and local dev. Packaged desktop builds are always 'sqlite'.
// Plan 2 of the multi-user work adds 'postgres' here.
const storage: 'sqlite' = 'sqlite';

// Per-IP rate limiting. Pointless on the desktop app (loopback, one user) and
// actively unhelpful there; on by default everywhere else.
const rateLimitEnabled = !isPackaged && optional('RATE_LIMIT_ENABLED', 'true') !== 'false';
```

and add `rateLimitEnabled,` to the exported `config` object next to `storage,`.

In `api/src/server.ts`, replace the two mode-conditional blocks (lines 32–44) with:

```ts
  await server.register(dbPlugin);
  await server.register(staticFilesPlugin);

  if (config.rateLimitEnabled) {
    // Per-IP limits, with stricter per-route settings on the expensive
    // endpoints (reason, upper-concepts).
    await server.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  }
```

- [ ] **Step 9: Verify nothing references the removed code**

```bash
cd /home/ensar/workspace/03_ids/sulo-schema-builder-main
grep -rn "localStore\|appConfig\|getStorageMode\|dexie\|fake-indexeddb\|SCHEMA_STORAGE=browser\|'browser'" \
  api/src frontend/src README.md docker-compose.yml docker/api/Dockerfile || echo "CLEAN"
```

Expected: `CLEAN`. If `README.md`, `docker-compose.yml` or `docker/api/Dockerfile` still mention `SCHEMA_STORAGE: browser` or browser storage, delete those lines and the surrounding explanation now (the compose `SCHEMA_STORAGE: browser` env entry and the Dockerfile `ENV SCHEMA_STORAGE=browser` line both go; Task 6 sets `postgres` in their place).

- [ ] **Step 10: Run every check**

```bash
cd frontend && npx tsc --noEmit && npm test
cd ../api && npx tsc --noEmit && npm test
```

Expected: both typechecks clean; all frontend and api tests pass. `frontend/src/api/localStore.test.ts` is gone; `schemaTransfer.test.ts` still runs its 6 tests.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "refactor: remove browser (IndexedDB) storage mode

The web deployment becomes a multi-user server, so per-visitor browser
storage and the app-config storage switch have no role. backend.ts is now
REST-only; schema transfer tests use an explicit in-memory fake."
```

---

### Task 2: Convert the repo to an npm workspace

**Files:**
- Create: `package.json` (root), `.npmrc` (root)
- Delete: `api/package-lock.json`, `frontend/package-lock.json`
- Modify: `.github/workflows/ci.yml:20-60`, `justfile:5-8`, `docker/api/Dockerfile`
- Test: existing suites, run through the new root scripts

**Interfaces:**
- Consumes: Task 1's cleaned packages.
- Produces: root scripts `npm run test`, `npm run typecheck`, `npm run build`, and workspace-scoped invocation via `npm -w sulo-schema-builder-api <script>` / `npm -w sulo-schema-builder-frontend <script>`. A single root `package-lock.json`.

- [ ] **Step 1: Create the root manifest**

Create `package.json`:

```json
{
  "name": "sulo-schema-builder",
  "version": "0.1.1",
  "private": true,
  "type": "module",
  "workspaces": [
    "api",
    "frontend",
    "packages/*"
  ],
  "scripts": {
    "typecheck": "npm run typecheck --workspaces --if-present",
    "test": "npm run test --workspaces --if-present",
    "build": "npm run build --workspaces --if-present"
  }
}
```

Add `"typecheck": "tsc --noEmit"` to `frontend/package.json`'s scripts (the api package already has one).

- [ ] **Step 2: Pin the install strategy**

Create `.npmrc` at the repo root:

```
# Each workspace keeps its own node_modules. Hoisting would move
# better-sqlite3 out of api/node_modules, and api/package.json's `pkg.assets`
# paths (node_modules/better-sqlite3/**) are resolved relative to the api
# package when building the desktop binary.
install-strategy=nested
```

- [ ] **Step 3: Reinstall from the root**

```bash
cd /home/ensar/workspace/03_ids/sulo-schema-builder-main
git rm api/package-lock.json frontend/package-lock.json
rm -rf api/node_modules frontend/node_modules
npm install
```

Expected: one `package-lock.json` at the root; `api/node_modules` and `frontend/node_modules` both populated.

- [ ] **Step 4: Verify both suites still run through the workspace**

```bash
npm run typecheck
npm test
```

Expected: api and frontend typechecks clean, all tests pass.

- [ ] **Step 5: Verify the frozen desktop build still packages**

```bash
node api/scripts/package-desktop.mjs
ls -la api/pkg-dist
```

Expected: a binary is produced. If it fails with a missing `better-sqlite3` `.node` asset, the install strategy did not take effect — confirm `.npmrc` is at the repo root and `api/node_modules/better-sqlite3` exists, then re-run `npm install`.

- [ ] **Step 6: Update CI to the workspace layout**

In `.github/workflows/ci.yml`, replace the four install/typecheck/test steps and the cache config with:

```yaml
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: package-lock.json

      - name: Install dependencies
        run: npm ci

      - name: Typecheck
        run: npm run typecheck

      - name: Test
        run: npm test

      # Catches build-only breakage (bad imports, Vite config) that tsc and
      # vitest both miss.
      - name: Build frontend
        run: npm run build -w sulo-schema-builder-frontend
```

- [ ] **Step 7: Update the justfile install recipe**

Replace the `install` recipe in `justfile`:

```make
# Install all workspace dependencies (api, frontend, packages/*).
install:
    npm install
```

- [ ] **Step 8: Update the Dockerfile to install from the root lockfile**

In `docker/api/Dockerfile`, both the `frontend-builder` and `builder` stages currently copy a per-package lockfile. Change each to copy the root manifests plus the relevant workspace manifest, then install that workspace. In `frontend-builder`:

```dockerfile
COPY package.json package-lock.json .npmrc ./
COPY frontend/package.json ./frontend/
RUN npm ci -w sulo-schema-builder-frontend
```

and build with `RUN npm run build -w sulo-schema-builder-frontend` after the `COPY frontend/... ./frontend/` lines (adjust the copied paths to `./frontend/` and set `WORKDIR /app`). In `builder`:

```dockerfile
COPY package.json package-lock.json .npmrc ./
COPY api/package.json ./api/
RUN npm ci -w sulo-schema-builder-api
```

with sources copied to `./api/` and `RUN npm run build -w sulo-schema-builder-api`. In the `production` and `development` stages, the artifact paths become `/app/api/dist`, `/app/api/node_modules`, `/app/frontend/dist`.

- [ ] **Step 9: Verify the image builds**

```bash
docker compose build api
```

Expected: build succeeds. Run `docker compose up -d api && curl -sf localhost:8080/api/v1/health && docker compose down` to confirm the container still serves.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "build: convert repo to npm workspaces

One root lockfile and root test/typecheck/build scripts, so a shared
package can be added next. install-strategy=nested keeps better-sqlite3
inside api/node_modules for the desktop pkg build."
```

---

### Task 3: Extract `packages/schema-core`

**Files:**
- Create: `packages/schema-core/package.json`, `packages/schema-core/tsconfig.json`, `packages/schema-core/vitest.config.ts`, `packages/schema-core/src/index.ts`, `packages/schema-core/src/types.ts`
- Move: `frontend/src/lib/ontologyExport.ts` → `packages/schema-core/src/ontologyExport.ts`; `frontend/src/lib/ontologyExport.test.ts` → `packages/schema-core/src/ontologyExport.test.ts`
- Modify: `frontend/src/api/ontology.ts:1-80`, `frontend/src/components/PropertyFeaturesEditor.tsx`, `frontend/src/pages/OntologyBuilderPage.tsx` (import paths only), `frontend/package.json`, `api/package.json`, `.github/workflows/ci.yml`
- Test: `packages/schema-core/src/ontologyExport.test.ts` (moved, unchanged assertions)

**Interfaces:**
- Consumes: Task 2's workspace.
- Produces: package `@sulo/schema-core` exporting, from `src/types.ts`: `TripleTemplate`, `PropertyFeature`, `OntologyClass`, `OntologyProperty`, `OntologySchema`, `OntologySchemaSummary`, `ServerClash`, `ConsistencyReport`; and from `src/ontologyExport.ts`: `PROPERTY_FEATURE_OWL`, `PROPERTY_FEATURES_ALL`, `extractNamedGroups`, `escTtl`, `shortenIri`, `turtleBlock`, `buildOwlExpr`, `buildReverseOwlExpr`, `ExportResult`, `generateExports`, `buildMermaid`. Consumed by the api in Task 6 for server-side OWL generation and by the frontend everywhere it generates exports.

- [ ] **Step 1: Create the package skeleton**

`packages/schema-core/package.json`:

```json
{
  "name": "@sulo/schema-core",
  "version": "0.1.1",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

`packages/schema-core/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "**/*.test.ts"]
}
```

`packages/schema-core/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 2: Move the shared types into the package**

Create `packages/schema-core/src/types.ts` by cutting the type declarations out of `frontend/src/api/ontology.ts` (lines 5–80: `OntologyClass`, `TripleTemplate`, `PropertyFeature`, `OntologyProperty`, `OntologySchema`, `OntologySchemaSummary`, `ServerClash`, `ConsistencyReport`) verbatim, each prefixed with `export`. Do not change a single field name or optionality — the 4065-line builder page depends on all of them.

- [ ] **Step 3: Move the generator and its tests**

```bash
cd /home/ensar/workspace/03_ids/sulo-schema-builder-main
git mv frontend/src/lib/ontologyExport.ts packages/schema-core/src/ontologyExport.ts
git mv frontend/src/lib/ontologyExport.test.ts packages/schema-core/src/ontologyExport.test.ts
```

In `packages/schema-core/src/ontologyExport.ts`, change the type import (line 7) to `from './types.js'`. In `packages/schema-core/src/ontologyExport.test.ts`, change the import of the module under test to `from './ontologyExport.js'` and any type import to `from './types.js'`.

Create `packages/schema-core/src/index.ts`:

```ts
export * from './types.js';
export * from './ontologyExport.js';
```

- [ ] **Step 4: Run the moved tests in their new home**

```bash
npm install                      # links the new workspace
npm test -w @sulo/schema-core
```

Expected: PASS — the same test count `ontologyExport.test.ts` had before the move (475 lines of assertions, unchanged).

- [ ] **Step 5: Re-point the frontend at the package**

Add to `frontend/package.json` dependencies: `"@sulo/schema-core": "*"`.

In `frontend/src/api/ontology.ts`, replace the deleted type block with a re-export so no consumer import path changes:

```ts
export type {
  OntologyClass,
  TripleTemplate,
  PropertyFeature,
  OntologyProperty,
  OntologySchema,
  OntologySchemaSummary,
  ServerClash,
  ConsistencyReport,
} from '@sulo/schema-core';
```

In `frontend/src/components/PropertyFeaturesEditor.tsx` and `frontend/src/pages/OntologyBuilderPage.tsx`, change every `from '../lib/ontologyExport.js'` / `from '../../lib/ontologyExport.js'` to `from '@sulo/schema-core'`. Change nothing else in those files.

- [ ] **Step 6: Let the api depend on the package**

Add to `api/package.json` dependencies: `"@sulo/schema-core": "*"`. Nothing imports it yet — Task 6 does.

- [ ] **Step 7: Build the package and verify every consumer**

```bash
npm install
npm run build -w @sulo/schema-core
npm run typecheck
npm test
npm run build -w sulo-schema-builder-frontend
```

Expected: all clean. The frontend build must succeed — Vite resolves `@sulo/schema-core` through the workspace symlink to `dist/`, which is why the build step above must run first.

- [ ] **Step 8: Make CI build the package before typechecking**

In `.github/workflows/ci.yml`, insert before the `Typecheck` step:

```yaml
      - name: Build shared package
        run: npm run build -w @sulo/schema-core
```

Add `packages/schema-core/dist` to `.gitignore`.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: extract @sulo/schema-core

The OWL/SHACL generator and the shared schema types move into a
dependency-free workspace package so the API can generate the same OWL the
frontend does — required for server-side reasoning."
```

---

### Task 4: Postgres plumbing, migrations, and a Testcontainers harness

**Files:**
- Create: `api/src/db/pg.ts`, `api/src/db/types.ts`, `api/src/db/migrate.ts`, `api/src/db/constants.ts`, `api/src/plugins/pg.ts`, `api/migrations/001_core.sql`, `api/migrations/002_local_owner.sql`, `api/scripts/migrate.ts`, `api/vitest.config.ts`, `api/test/pg.ts`, `api/src/db/migrate.test.ts`
- Modify: `api/package.json`, `api/src/config.ts`, `docker-compose.yml`
- Test: `api/src/db/migrate.test.ts`

**Interfaces:**
- Consumes: Task 2's workspace.
- Produces:
  - `runMigrations(pool: Pool, dir: string): Promise<string[]>` — returns the versions applied by this call; empty array when already current.
  - `api/src/db/types.ts` exporting `interface DB` with tables `users`, `schemas`, `classes`, `properties`, `schema_grants`, `reasoning_reports`, `reason_jobs`, `usage_events`, plus row/insert/update types via Kysely's `Generated`, `Selectable`, `Insertable`, `Updateable`.
  - `createKysely(url: string, poolMax: number): { db: Kysely<DB>; pool: Pool }`.
  - `fastify.pg: Kysely<DB>` decorator from `plugins/pg.ts`.
  - `LOCAL_OWNER_ID = '00000000-0000-0000-0000-000000000001'`.
  - `startTestDb(): Promise<{ db: Kysely<DB>; pool: Pool; stop: () => Promise<void> }>` and `truncateAll(db)` from `api/test/pg.ts`.

- [ ] **Step 1: Add the dependencies**

```bash
cd /home/ensar/workspace/03_ids/sulo-schema-builder-main
npm install -w sulo-schema-builder-api pg kysely
npm install -w sulo-schema-builder-api -D @types/pg @testcontainers/postgresql
```

- [ ] **Step 2: Add a vitest config with a container-friendly timeout**

Create `api/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Postgres-backed tests start a Docker container per test file.
    testTimeout: 120_000,
    hookTimeout: 180_000,
    // Containers are expensive; one file at a time keeps the machine sane.
    fileParallelism: false,
  },
});
```

- [ ] **Step 3: Write the failing migration-runner test**

Create `api/src/db/migrate.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { resolve } from 'node:path';
import { runMigrations } from './migrate.js';

const MIGRATIONS_DIR = resolve(import.meta.dirname, '..', '..', 'migrations');

describe('runMigrations', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
  });

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it('applies every migration once and is idempotent', async () => {
    const first = await runMigrations(pool, MIGRATIONS_DIR);
    expect(first).toContain('001_core.sql');
    expect(first).toContain('002_local_owner.sql');

    const second = await runMigrations(pool, MIGRATIONS_DIR);
    expect(second).toEqual([]);
  });

  it('creates the core tables with their constraints', async () => {
    await runMigrations(pool, MIGRATIONS_DIR);

    const { rows } = await pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' order by table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'classes', 'properties', 'reason_jobs', 'reasoning_reports',
      'schema_migrations', 'schema_grants', 'schemas', 'usage_events', 'users',
    ].sort());

    await expect(
      pool.query(`insert into schemas (owner_id, title, visibility)
                  values ('00000000-0000-0000-0000-000000000001', 'bad', 'nonsense')`),
    ).rejects.toThrow(/visibility/);
  });

  it('seeds exactly one local owner', async () => {
    await runMigrations(pool, MIGRATIONS_DIR);

    const { rows } = await pool.query<{ id: string; subject: string }>('select id, subject from users');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('00000000-0000-0000-0000-000000000001');
    expect(rows[0].subject).toBe('local');
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npm test -w sulo-schema-builder-api -- src/db/migrate.test.ts`
Expected: FAIL — `Cannot find module './migrate.js'`.

- [ ] **Step 5: Write the migration runner**

Create `api/src/db/migrate.ts`:

```ts
// Versioned SQL migrations. Files in api/migrations/ named NNN_description.sql
// are applied in lexical order, each inside its own transaction, and recorded
// in schema_migrations. Applied files are never edited — add a new one.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';

export async function runMigrations(pool: Pool, dir: string): Promise<string[]> {
  await pool.query(`
    create table if not exists schema_migrations (
      version    text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query<{ version: string }>('select version from schema_migrations');
  const applied = new Set(rows.map((r) => r.version));

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (version) values ($1)', [file]);
      await client.query('commit');
      ran.push(file);
    } catch (err) {
      await client.query('rollback');
      throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
    } finally {
      client.release();
    }
  }
  return ran;
}
```

- [ ] **Step 6: Write migration 001 — the core schema**

Create `api/migrations/001_core.sql` exactly as the spec's section 3 defines it:

```sql
create extension if not exists pgcrypto;

create table users (
  id           uuid primary key default gen_random_uuid(),
  subject      text unique not null,
  email        text,
  display_name text,
  orcid        text,
  global_role  text not null default 'user'  check (global_role in ('user','moderator','admin')),
  quota_tier   text not null default 'free'  check (quota_tier in ('free','verified','staff')),
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz
);

create table reasoning_reports (
  cache_key   text primary key,
  report      jsonb not null,
  reasoner    text not null,
  sulo_hash   text not null,
  duration_ms integer,
  created_at  timestamptz not null default now()
);

create table schemas (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references users(id) on delete cascade,
  title              text not null,
  description        text,
  upper_ontology_iri text,
  base_uri           text,
  visibility         text not null default 'private'
                     check (visibility in ('private','unlisted','public')),
  content_hash       text,
  latest_report_key  text references reasoning_reports(cache_key) on delete set null,
  reason_state       text not null default 'stale'
                     check (reason_state in ('stale','queued','running','fresh','failed')),
  created_at         timestamptz not null default now(),
  modified_at        timestamptz not null default now()
);
create index schemas_owner_idx on schemas (owner_id);
create index schemas_public_idx on schemas (visibility) where visibility = 'public';

create table classes (
  id                  uuid primary key default gen_random_uuid(),
  schema_id           uuid not null references schemas(id) on delete cascade,
  name                text not null,
  label               text,
  description         text,
  maps_to_concept_iri text,
  super_class_id      uuid references classes(id) on delete set null
);
create index classes_schema_idx on classes (schema_id);

create table properties (
  id                     uuid primary key default gen_random_uuid(),
  schema_id              uuid not null references schemas(id) on delete cascade,
  name                   text not null,
  label                  text,
  description            text,
  property_type          text not null default 'datatype'
                         check (property_type in ('object','datatype')),
  domain_class_id        uuid references classes(id) on delete set null,
  range_class_iri        text,
  mapping_pattern        jsonb,
  regex_pattern          text,
  regex_variable         text,
  is_required            boolean not null default false,
  property_features      jsonb,
  inverse_property_iri   text,
  disjoint_property_iris jsonb
);
create index properties_schema_idx on properties (schema_id);

create table schema_grants (
  schema_id  uuid references schemas(id) on delete cascade,
  grantee_id uuid references users(id)   on delete cascade,
  role       text not null check (role in ('viewer','editor','owner')),
  granted_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (schema_id, grantee_id)
);

create table reason_jobs (
  id           bigserial primary key,
  schema_id    uuid not null references schemas(id) on delete cascade,
  requested_by uuid references users(id) on delete set null,
  cache_key    text not null,
  state        text not null check (state in ('queued','running','done','failed')),
  attempts     integer not null default 0,
  enqueued_at  timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  error        text
);
create unique index reason_jobs_one_active_per_schema
  on reason_jobs (schema_id) where state in ('queued','running');

create table usage_events (
  id         bigserial primary key,
  user_id    uuid references users(id) on delete set null,
  kind       text not null,
  schema_id  uuid,
  cost_ms    integer,
  cache_hit  boolean not null default false,
  created_at timestamptz not null default now()
);
create index usage_events_user_time_idx on usage_events (user_id, created_at desc);
```

- [ ] **Step 7: Write migration 002 — the pre-auth owner row**

Create `api/migrations/002_local_owner.sql`:

```sql
-- Until authentication lands (plan 2), every schema is owned by this row.
-- It stays afterwards as an ordinary user record; nothing special-cases it
-- except the pre-auth request context.
insert into users (id, subject, display_name, global_role, quota_tier)
values ('00000000-0000-0000-0000-000000000001', 'local', 'Local user', 'admin', 'staff')
on conflict (subject) do nothing;
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm test -w sulo-schema-builder-api -- src/db/migrate.test.ts`
Expected: PASS (3 tests). Docker must be running.

- [ ] **Step 9: Add the Kysely table types**

Create `api/src/db/types.ts`:

```ts
import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface UsersTable {
  id: Generated<string>;
  subject: string;
  email: string | null;
  display_name: string | null;
  orcid: string | null;
  global_role: Generated<'user' | 'moderator' | 'admin'>;
  quota_tier: Generated<'free' | 'verified' | 'staff'>;
  created_at: Generated<Timestamp>;
  last_seen_at: Timestamp | null;
}

export interface SchemasTable {
  id: Generated<string>;
  owner_id: string;
  title: string;
  description: string | null;
  upper_ontology_iri: string | null;
  base_uri: string | null;
  visibility: Generated<'private' | 'unlisted' | 'public'>;
  content_hash: string | null;
  latest_report_key: string | null;
  reason_state: Generated<'stale' | 'queued' | 'running' | 'fresh' | 'failed'>;
  created_at: Generated<Timestamp>;
  modified_at: Generated<Timestamp>;
}

export interface ClassesTable {
  id: Generated<string>;
  schema_id: string;
  name: string;
  label: string | null;
  description: string | null;
  maps_to_concept_iri: string | null;
  super_class_id: string | null;
}

export interface TripleTemplateJson {
  subject: string;
  predicate: string;
  object: string;
}

export interface PropertiesTable {
  id: Generated<string>;
  schema_id: string;
  name: string;
  label: string | null;
  description: string | null;
  property_type: Generated<'object' | 'datatype'>;
  domain_class_id: string | null;
  range_class_iri: string | null;
  mapping_pattern: ColumnType<TripleTemplateJson[] | null, string | null, string | null>;
  regex_pattern: string | null;
  regex_variable: string | null;
  is_required: Generated<boolean>;
  property_features: ColumnType<string[] | null, string | null, string | null>;
  inverse_property_iri: string | null;
  disjoint_property_iris: ColumnType<string[] | null, string | null, string | null>;
}

export interface SchemaGrantsTable {
  schema_id: string;
  grantee_id: string;
  role: 'viewer' | 'editor' | 'owner';
  granted_by: string | null;
  created_at: Generated<Timestamp>;
}

export interface ReasoningReportsTable {
  cache_key: string;
  report: ColumnType<unknown, string, string>;
  reasoner: string;
  sulo_hash: string;
  duration_ms: number | null;
  created_at: Generated<Timestamp>;
}

export interface ReasonJobsTable {
  id: Generated<number>;
  schema_id: string;
  requested_by: string | null;
  cache_key: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  attempts: Generated<number>;
  enqueued_at: Generated<Timestamp>;
  started_at: Timestamp | null;
  finished_at: Timestamp | null;
  error: string | null;
}

export interface UsageEventsTable {
  id: Generated<number>;
  user_id: string | null;
  kind: string;
  schema_id: string | null;
  cost_ms: number | null;
  cache_hit: Generated<boolean>;
  created_at: Generated<Timestamp>;
}

export interface DB {
  users: UsersTable;
  schemas: SchemasTable;
  classes: ClassesTable;
  properties: PropertiesTable;
  schema_grants: SchemaGrantsTable;
  reasoning_reports: ReasoningReportsTable;
  reason_jobs: ReasonJobsTable;
  usage_events: UsageEventsTable;
}

export type SchemaRow = Selectable<SchemasTable>;
export type NewSchema = Insertable<SchemasTable>;
export type SchemaUpdate = Updateable<SchemasTable>;
export type ClassRow = Selectable<ClassesTable>;
export type NewClass = Insertable<ClassesTable>;
export type ClassUpdate = Updateable<ClassesTable>;
export type PropertyRow = Selectable<PropertiesTable>;
export type NewProperty = Insertable<PropertiesTable>;
export type PropertyUpdate = Updateable<PropertiesTable>;
```

The three `jsonb` columns are typed as `string` on write so callers pass `JSON.stringify(...)` explicitly — `pg` would otherwise send a JS array as a Postgres array literal.

- [ ] **Step 10: Add the connection factory, the constant, and the plugin**

`api/src/db/constants.ts`:

```ts
/** Owner of every schema until authentication lands (migration 002). */
export const LOCAL_OWNER_ID = '00000000-0000-0000-0000-000000000001';
```

`api/src/db/pg.ts`:

```ts
import { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import type { DB } from './types.js';

export function createKysely(url: string, poolMax: number): { db: Kysely<DB>; pool: Pool } {
  const pool = new Pool({ connectionString: url, max: poolMax });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  return { db, pool };
}
```

`api/src/plugins/pg.ts`:

```ts
import fp from 'fastify-plugin';
import type { Kysely } from 'kysely';
import { createKysely } from '../db/pg.js';
import type { DB } from '../db/types.js';
import { config } from '../config.js';

declare module 'fastify' {
  interface FastifyInstance {
    pg: Kysely<DB>;
  }
}

export default fp(async (fastify) => {
  const { db } = createKysely(config.postgres.url, config.postgres.poolMax);
  fastify.decorate('pg', db);

  fastify.addHook('onClose', async () => {
    await db.destroy();
  });

  fastify.log.info('Postgres pool opened');
});
```

- [ ] **Step 11: Add Postgres config and a migrate script**

In `api/src/config.ts`, add to the exported object:

```ts
  postgres: {
    // Required when SCHEMA_STORAGE=postgres; unused by the desktop/SQLite path.
    url: optional('DATABASE_URL', 'postgres://sulo:sulo@localhost:5432/sulo'),
    poolMax: parseInt(optional('DATABASE_POOL_MAX', '10'), 10),
  },
```

Create `api/scripts/migrate.ts`:

```ts
// Standalone migration entry point. Run before starting the server — never
// from inside it, so N replicas cannot race each other.
//   npm run migrate -w sulo-schema-builder-api

import { Pool } from 'pg';
import { resolve } from 'node:path';
import { runMigrations } from '../src/db/migrate.js';
import { config } from '../src/config.js';

const pool = new Pool({ connectionString: config.postgres.url });
try {
  const applied = await runMigrations(pool, resolve(import.meta.dirname, '..', 'migrations'));
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'already up to date');
} finally {
  await pool.end();
}
```

Add to `api/package.json` scripts: `"migrate": "tsx scripts/migrate.ts"`.

- [ ] **Step 12: Add the Testcontainers harness for later tasks**

Create `api/test/pg.ts`:

```ts
// Shared Postgres test harness. One container per test file: start it in
// beforeAll, truncate between tests, stop it in afterAll.

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { resolve } from 'node:path';
import { runMigrations } from '../src/db/migrate.js';
import type { DB } from '../src/db/types.js';

export interface TestDb {
  db: Kysely<DB>;
  pool: Pool;
  stop: () => Promise<void>;
}

export async function startTestDb(): Promise<TestDb> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16-alpine').start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  await runMigrations(pool, resolve(import.meta.dirname, '..', 'migrations'));
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  return {
    db,
    pool,
    stop: async () => {
      await db.destroy();
      await container.stop();
    },
  };
}

/** Clears schema data between tests; leaves the seeded users row intact. */
export async function truncateAll(db: Kysely<DB>): Promise<void> {
  await sql`truncate table usage_events, reason_jobs, schema_grants, properties, classes, schemas, reasoning_reports restart identity cascade`.execute(db);
}
```

- [ ] **Step 13: Add Postgres to compose**

In `docker-compose.yml`, add the service and wire the api to it:

```yaml
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: sulo
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-sulo}
      POSTGRES_DB: sulo
    volumes:
      - sulo-db:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U sulo -d sulo"]
      interval: 5s
      timeout: 3s
      retries: 20
    networks:
      - sulo-net
    restart: unless-stopped
```

Add to the `api` service:

```yaml
    environment:
      DATABASE_URL: postgres://sulo:${POSTGRES_PASSWORD:-sulo}@db:5432/sulo
    depends_on:
      db:
        condition: service_healthy
```

and add a top-level `volumes:` block with `sulo-db:`. Leave `SCHEMA_STORAGE` alone for now — Task 6 sets it to `postgres` once the routes exist.

- [ ] **Step 14: Verify everything**

```bash
npm run typecheck -w sulo-schema-builder-api
npm test -w sulo-schema-builder-api
docker compose up -d db && sleep 5
DATABASE_URL=postgres://sulo:sulo@localhost:5432/sulo npm run migrate -w sulo-schema-builder-api
DATABASE_URL=postgres://sulo:sulo@localhost:5432/sulo npm run migrate -w sulo-schema-builder-api
docker compose down
```

Expected: typecheck clean, tests pass, the first migrate prints `applied: 001_core.sql, 002_local_owner.sql`, the second prints `already up to date`. (Publish port 5432 on the `db` service temporarily, or run the migrate commands with `docker compose exec`.)

- [ ] **Step 15: Commit**

```bash
git add -A
git commit -m "feat(api): Postgres plumbing, SQL migrations, test harness

Adds the full core schema from the design doc as migration 001, a
transactional migration runner with an idempotence test, Kysely types and
pool plugin, and a Testcontainers harness the schema modules build on."
```

---

### Task 5: `modules/schemas` repository and service (parity, Postgres)

**Files:**
- Create: `api/src/modules/schemas/repo.ts`, `api/src/modules/schemas/mappers.ts`, `api/src/modules/schemas/service.ts`, `api/src/modules/schemas/schemas.ts`, `api/src/modules/schemas/repo.test.ts`
- Test: `api/src/modules/schemas/repo.test.ts`

**Interfaces:**
- Consumes: `Kysely<DB>`, the row types and `LOCAL_OWNER_ID` from Task 4; `startTestDb`/`truncateAll` from `api/test/pg.ts`.
- Produces:
  - `repo.ts`: `listSchemas(db, ownerId)`, `getSchemaRow(db, id)`, `insertSchema(db, values: NewSchema)`, `patchSchema(db, id, values: SchemaUpdate)`, `removeSchema(db, id)`, `listClasses(db, schemaId)`, `insertClass(db, values: NewClass)`, `patchClass(db, id, values: ClassUpdate)`, `removeClass(db, id)`, `listProperties(db, schemaId)`, `insertProperty(db, values: NewProperty)`, `patchProperty(db, id, values: PropertyUpdate)`, `removeProperty(db, id)`. Every one takes the `Kysely<DB>` instance as its first argument; none reads global state.
  - `mappers.ts`: `schemaIri(id)`, `classIri(id)`, `propIri(id)`, `schemaRowToSummary(row)`, `classRowToApi(row)`, `propertyRowToApi(row)`, `normalizeBaseUri(uri)`.
  - `service.ts`: `getSchemaWithChildren(db, id)` returning the full API shape or `undefined`; `createSchema(db, ownerId, input)`; `updateSchema(db, id, patch)`; `deleteSchema(db, id)`; `addClass`/`updateClass`/`deleteClass`/`addProperty`/`updateProperty`/`deleteProperty` mirroring today's REST behaviour.
  - `schemas.ts`: the zod bodies/params, moved verbatim from `api/src/routes/v1/ontology.ts:10-95` (`CreateOntologySchemaBody`, `UpdateOntologySchemaBody`, `AddClassBody`, `UpdateClassBody`, `AddPropertyBody`, `UpdatePropertyBody`, `TripleTemplateBody`, `PropertyFeatureEnum`, `IdParam`, `ClassIdParam`, `PropIdParam`).

- [ ] **Step 1: Write the failing repository/service test**

Create `api/src/modules/schemas/repo.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestDb, truncateAll, type TestDb } from '../../../test/pg.js';
import { LOCAL_OWNER_ID } from '../../db/constants.js';
import * as service from './service.js';

let t: TestDb;

beforeAll(async () => { t = await startTestDb(); });
afterAll(async () => { await t.stop(); });
beforeEach(async () => { await truncateAll(t.db); });

describe('schemas service', () => {
  it('creates a schema and reads it back with empty children', async () => {
    const created = await service.createSchema(t.db, LOCAL_OWNER_ID, { title: 'Clinical', description: 'demo' });

    expect(created.id).toBeTruthy();
    expect(created.url).toContain(created.id);

    const full = await service.getSchemaWithChildren(t.db, created.id);
    expect(full).toMatchObject({ title: 'Clinical', description: 'demo', classes: [], properties: [] });
  });

  it('normalizes baseUri on create and on update', async () => {
    const created = await service.createSchema(t.db, LOCAL_OWNER_ID, {
      title: 'A', baseUri: 'https://example.org/ns',
    });
    expect(created.baseUri).toBe('https://example.org/ns/');

    await service.updateSchema(t.db, created.id, { baseUri: 'https://example.org/other#' });
    expect((await service.getSchemaWithChildren(t.db, created.id))!.baseUri).toBe('https://example.org/other#');
  });

  it('lists an owner schemas ordered by title', async () => {
    await service.createSchema(t.db, LOCAL_OWNER_ID, { title: 'Zebra' });
    await service.createSchema(t.db, LOCAL_OWNER_ID, { title: 'Alpha' });

    const list = await service.listSchemas(t.db, LOCAL_OWNER_ID);
    expect(list.map((s) => s.title)).toEqual(['Alpha', 'Zebra']);
  });

  it('returns undefined for a missing schema', async () => {
    expect(await service.getSchemaWithChildren(t.db, '11111111-1111-1111-1111-111111111111')).toBeUndefined();
  });

  it('round-trips classes and properties including jsonb columns', async () => {
    const schema = await service.createSchema(t.db, LOCAL_OWNER_ID, { title: 'Family' });
    const parent = await service.addClass(t.db, schema.id, { name: 'Event' });
    const child = await service.addClass(t.db, schema.id, { name: 'Visit', superClassId: parent.id });

    const prop = await service.addProperty(t.db, schema.id, {
      name: 'occursIn',
      propertyType: 'object',
      domainClassId: child.id,
      rangeClassIri: parent.url,
      mappingPattern: [{ subject: '?this', predicate: 'https://w3id.org/sulo/isPartOf', object: parent.url }],
      isRequired: true,
      propertyFeatures: ['functional'],
      disjointPropertyIris: ['https://example.org/external'],
    });

    const full = (await service.getSchemaWithChildren(t.db, schema.id))!;
    expect(full.classes.map((c) => c.name)).toEqual(['Event', 'Visit']);
    expect(full.classes.find((c) => c.name === 'Visit')!.superClassId).toBe(parent.id);

    const readBack = full.properties.find((p) => p.id === prop.id)!;
    expect(readBack.mappingPattern).toEqual([
      { subject: '?this', predicate: 'https://w3id.org/sulo/isPartOf', object: parent.url },
    ]);
    expect(readBack.propertyFeatures).toEqual(['functional']);
    expect(readBack.disjointPropertyIris).toEqual(['https://example.org/external']);
    expect(readBack.isRequired).toBe(true);
  });

  it('treats an empty-string patch value as a field clear', async () => {
    const schema = await service.createSchema(t.db, LOCAL_OWNER_ID, { title: 'Family' });
    const parent = await service.addClass(t.db, schema.id, { name: 'Event' });
    const child = await service.addClass(t.db, schema.id, {
      name: 'Visit', superClassId: parent.id, mapsToConceptIri: 'https://w3id.org/sulo/Process',
    });

    await service.updateClass(t.db, child.id, { superClassId: '', mapsToConceptIri: '' });

    const full = (await service.getSchemaWithChildren(t.db, schema.id))!;
    const updated = full.classes.find((c) => c.id === child.id)!;
    expect(updated.superClassId).toBeUndefined();
    expect(updated.mapsToConceptIri).toBeUndefined();
    expect(updated.name).toBe('Visit');
  });

  it('cascades deletes to classes and properties', async () => {
    const schema = await service.createSchema(t.db, LOCAL_OWNER_ID, { title: 'Doomed' });
    await service.addClass(t.db, schema.id, { name: 'Gone' });
    await service.addProperty(t.db, schema.id, { name: 'alsoGone', propertyType: 'datatype' });

    await service.deleteSchema(t.db, schema.id);

    expect(await service.getSchemaWithChildren(t.db, schema.id)).toBeUndefined();
    const { rows } = await t.pool.query('select count(*)::int as n from classes');
    expect(rows[0].n).toBe(0);
  });

  it('nulls the domain reference when a class a property points at is deleted', async () => {
    const schema = await service.createSchema(t.db, LOCAL_OWNER_ID, { title: 'Refs' });
    const cls = await service.addClass(t.db, schema.id, { name: 'Subject' });
    const prop = await service.addProperty(t.db, schema.id, {
      name: 'hasName', propertyType: 'datatype', domainClassId: cls.id,
    });

    await service.deleteClass(t.db, cls.id);

    const full = (await service.getSchemaWithChildren(t.db, schema.id))!;
    expect(full.properties.find((p) => p.id === prop.id)!.domainClassId).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w sulo-schema-builder-api -- src/modules/schemas/repo.test.ts`
Expected: FAIL — `Cannot find module './service.js'`.

- [ ] **Step 3: Write the mappers**

Create `api/src/modules/schemas/mappers.ts`:

```ts
// Row → API shape. The IRIs minted here are embedded in exports and stored
// verbatim in cross-references (rangeClassIri, mapping patterns), so they must
// stay byte-identical to the values the SQLite path produced.

import { PREFIXES } from '../../rdf/prefixes.js';
import type { ClassRow, PropertyRow, SchemaRow } from '../../db/types.js';

const SHEXR = PREFIXES.suloschemaR;

export const schemaIri = (id: string) => `${SHEXR}ontology-schema/${id}`;
export const classIri = (id: string) => `${SHEXR}ontology-class/${id}`;
export const propIri = (id: string) => `${SHEXR}ontology-prop/${id}`;

export function normalizeBaseUri(uri: string): string {
  return /[/#]$/.test(uri) ? uri : `${uri}/`;
}

export function schemaRowToSummary(row: SchemaRow) {
  return {
    id: row.id,
    url: schemaIri(row.id),
    title: row.title,
    description: row.description ?? undefined,
    upperOntologyIri: row.upper_ontology_iri ?? undefined,
    baseUri: row.base_uri ?? undefined,
  };
}

export function classRowToApi(row: ClassRow) {
  return {
    id: row.id,
    url: classIri(row.id),
    name: row.name,
    label: row.label ?? undefined,
    description: row.description ?? undefined,
    mapsToConceptIri: row.maps_to_concept_iri ?? undefined,
    superClassId: row.super_class_id ?? undefined,
  };
}

export function propertyRowToApi(row: PropertyRow) {
  return {
    id: row.id,
    url: propIri(row.id),
    name: row.name,
    label: row.label ?? undefined,
    description: row.description ?? undefined,
    propertyType: row.property_type,
    domainClassId: row.domain_class_id ?? undefined,
    rangeClassIri: row.range_class_iri ?? undefined,
    mappingPattern: row.mapping_pattern ?? [],
    regexPattern: row.regex_pattern ?? undefined,
    regexVariable: row.regex_variable ?? undefined,
    isRequired: row.is_required,
    propertyFeatures: row.property_features ?? [],
    inversePropertyIri: row.inverse_property_iri ?? undefined,
    disjointPropertyIris: row.disjoint_property_iris ?? [],
  };
}
```

- [ ] **Step 4: Write the repository**

Create `api/src/modules/schemas/repo.ts`:

```ts
// Every query against schemas/classes/properties lives here. Callers pass the
// Kysely instance in; nothing in this file reads global state, so tests can
// point it at a throwaway container.

import type { Kysely } from 'kysely';
import type {
  ClassRow, ClassUpdate, DB, NewClass, NewProperty, NewSchema,
  PropertyRow, PropertyUpdate, SchemaRow, SchemaUpdate,
} from '../../db/types.js';

export async function listSchemas(db: Kysely<DB>, ownerId: string): Promise<SchemaRow[]> {
  return db.selectFrom('schemas').selectAll().where('owner_id', '=', ownerId).orderBy('title').execute();
}

export async function getSchemaRow(db: Kysely<DB>, id: string): Promise<SchemaRow | undefined> {
  return db.selectFrom('schemas').selectAll().where('id', '=', id).executeTakeFirst();
}

export async function insertSchema(db: Kysely<DB>, values: NewSchema): Promise<SchemaRow> {
  return db.insertInto('schemas').values(values).returningAll().executeTakeFirstOrThrow();
}

export async function patchSchema(db: Kysely<DB>, id: string, values: SchemaUpdate): Promise<void> {
  await db.updateTable('schemas').set({ ...values, modified_at: new Date() }).where('id', '=', id).execute();
}

export async function removeSchema(db: Kysely<DB>, id: string): Promise<void> {
  await db.deleteFrom('schemas').where('id', '=', id).execute();
}

export async function listClasses(db: Kysely<DB>, schemaId: string): Promise<ClassRow[]> {
  return db.selectFrom('classes').selectAll().where('schema_id', '=', schemaId).orderBy('name').execute();
}

export async function insertClass(db: Kysely<DB>, values: NewClass): Promise<ClassRow> {
  return db.insertInto('classes').values(values).returningAll().executeTakeFirstOrThrow();
}

export async function patchClass(db: Kysely<DB>, id: string, values: ClassUpdate): Promise<void> {
  if (Object.keys(values).length === 0) return;
  await db.updateTable('classes').set(values).where('id', '=', id).execute();
}

export async function removeClass(db: Kysely<DB>, id: string): Promise<void> {
  await db.deleteFrom('classes').where('id', '=', id).execute();
}

export async function listProperties(db: Kysely<DB>, schemaId: string): Promise<PropertyRow[]> {
  return db.selectFrom('properties').selectAll().where('schema_id', '=', schemaId).orderBy('name').execute();
}

export async function insertProperty(db: Kysely<DB>, values: NewProperty): Promise<PropertyRow> {
  return db.insertInto('properties').values(values).returningAll().executeTakeFirstOrThrow();
}

export async function patchProperty(db: Kysely<DB>, id: string, values: PropertyUpdate): Promise<void> {
  if (Object.keys(values).length === 0) return;
  await db.updateTable('properties').set(values).where('id', '=', id).execute();
}

export async function removeProperty(db: Kysely<DB>, id: string): Promise<void> {
  await db.deleteFrom('properties').where('id', '=', id).execute();
}
```

- [ ] **Step 5: Write the service**

Create `api/src/modules/schemas/service.ts`:

```ts
// Orchestration over repo.ts: input normalisation, PATCH semantics ('' clears
// a field, absent leaves it), and assembling the full API response shape.

import type { Kysely } from 'kysely';
import type { DB } from '../../db/types.js';
import * as repo from './repo.js';
import { classRowToApi, normalizeBaseUri, propertyRowToApi, schemaIri, schemaRowToSummary } from './mappers.js';

export interface SchemaInput {
  title: string;
  description?: string;
  upperOntologyIri?: string;
  baseUri?: string;
}
export type SchemaPatch = Partial<SchemaInput>;

export interface ClassInput {
  name: string;
  label?: string;
  description?: string;
  mapsToConceptIri?: string;
  superClassId?: string;
}
export type ClassPatch = Partial<ClassInput>;

export interface PropertyInput {
  name: string;
  label?: string;
  description?: string;
  propertyType: 'object' | 'datatype';
  domainClassId?: string;
  rangeClassIri?: string;
  mappingPattern?: { subject: string; predicate: string; object: string }[];
  regexPattern?: string;
  regexVariable?: string;
  isRequired?: boolean;
  propertyFeatures?: string[];
  inversePropertyIri?: string;
  disjointPropertyIris?: string[];
}
export type PropertyPatch = Partial<PropertyInput>;

/** '' means "clear this nullable column"; undefined means "leave it alone". */
function nullable(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value === '' ? null : value;
}

function jsonOrNull(value: unknown[] | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value.length > 0 ? JSON.stringify(value) : null;
}

export async function listSchemas(db: Kysely<DB>, ownerId: string) {
  return (await repo.listSchemas(db, ownerId)).map(schemaRowToSummary);
}

export async function getSchemaWithChildren(db: Kysely<DB>, id: string) {
  const row = await repo.getSchemaRow(db, id);
  if (!row) return undefined;

  const [classes, properties] = await Promise.all([
    repo.listClasses(db, id),
    repo.listProperties(db, id),
  ]);

  return {
    ...schemaRowToSummary(row),
    url: schemaIri(row.id),
    classes: classes.map(classRowToApi),
    properties: properties.map(propertyRowToApi),
  };
}

export async function createSchema(db: Kysely<DB>, ownerId: string, input: SchemaInput) {
  const row = await repo.insertSchema(db, {
    owner_id: ownerId,
    title: input.title,
    description: input.description ?? null,
    upper_ontology_iri: input.upperOntologyIri ?? null,
    base_uri: input.baseUri ? normalizeBaseUri(input.baseUri) : null,
  });
  return { ...schemaRowToSummary(row), classes: [], properties: [] };
}

export async function updateSchema(db: Kysely<DB>, id: string, patch: SchemaPatch): Promise<void> {
  await repo.patchSchema(db, id, {
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.description !== undefined ? { description: nullable(patch.description) } : {}),
    ...(patch.upperOntologyIri !== undefined ? { upper_ontology_iri: nullable(patch.upperOntologyIri) } : {}),
    ...(patch.baseUri !== undefined
      ? { base_uri: patch.baseUri === '' ? null : normalizeBaseUri(patch.baseUri) }
      : {}),
  });
}

export async function deleteSchema(db: Kysely<DB>, id: string): Promise<void> {
  await repo.removeSchema(db, id);
}

export async function addClass(db: Kysely<DB>, schemaId: string, input: ClassInput) {
  const row = await repo.insertClass(db, {
    schema_id: schemaId,
    name: input.name,
    label: input.label ?? null,
    description: input.description ?? null,
    maps_to_concept_iri: input.mapsToConceptIri ?? null,
    super_class_id: input.superClassId ?? null,
  });
  return classRowToApi(row);
}

export async function updateClass(db: Kysely<DB>, classId: string, patch: ClassPatch): Promise<void> {
  await repo.patchClass(db, classId, {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.label !== undefined ? { label: nullable(patch.label) } : {}),
    ...(patch.description !== undefined ? { description: nullable(patch.description) } : {}),
    ...(patch.mapsToConceptIri !== undefined ? { maps_to_concept_iri: nullable(patch.mapsToConceptIri) } : {}),
    ...(patch.superClassId !== undefined ? { super_class_id: nullable(patch.superClassId) } : {}),
  });
}

export async function deleteClass(db: Kysely<DB>, classId: string): Promise<void> {
  await repo.removeClass(db, classId);
}

export async function addProperty(db: Kysely<DB>, schemaId: string, input: PropertyInput) {
  const row = await repo.insertProperty(db, {
    schema_id: schemaId,
    name: input.name,
    label: input.label ?? null,
    description: input.description ?? null,
    property_type: input.propertyType,
    domain_class_id: input.domainClassId ?? null,
    range_class_iri: input.rangeClassIri ?? null,
    mapping_pattern: jsonOrNull(input.mappingPattern) ?? null,
    regex_pattern: input.regexPattern ?? null,
    regex_variable: input.regexVariable ?? null,
    is_required: input.isRequired ?? false,
    property_features: jsonOrNull(input.propertyFeatures) ?? null,
    inverse_property_iri: input.inversePropertyIri ?? null,
    disjoint_property_iris: jsonOrNull(input.disjointPropertyIris) ?? null,
  });
  return propertyRowToApi(row);
}

export async function updateProperty(db: Kysely<DB>, propId: string, patch: PropertyPatch): Promise<void> {
  await repo.patchProperty(db, propId, {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.label !== undefined ? { label: nullable(patch.label) } : {}),
    ...(patch.description !== undefined ? { description: nullable(patch.description) } : {}),
    ...(patch.propertyType !== undefined ? { property_type: patch.propertyType } : {}),
    ...(patch.domainClassId !== undefined ? { domain_class_id: nullable(patch.domainClassId) } : {}),
    ...(patch.rangeClassIri !== undefined ? { range_class_iri: nullable(patch.rangeClassIri) } : {}),
    ...(patch.mappingPattern !== undefined ? { mapping_pattern: jsonOrNull(patch.mappingPattern) } : {}),
    ...(patch.regexPattern !== undefined ? { regex_pattern: nullable(patch.regexPattern) } : {}),
    ...(patch.regexVariable !== undefined ? { regex_variable: nullable(patch.regexVariable) } : {}),
    ...(patch.isRequired !== undefined ? { is_required: patch.isRequired } : {}),
    ...(patch.propertyFeatures !== undefined ? { property_features: jsonOrNull(patch.propertyFeatures) } : {}),
    ...(patch.inversePropertyIri !== undefined ? { inverse_property_iri: nullable(patch.inversePropertyIri) } : {}),
    ...(patch.disjointPropertyIris !== undefined
      ? { disjoint_property_iris: jsonOrNull(patch.disjointPropertyIris) }
      : {}),
  });
}

export async function deleteProperty(db: Kysely<DB>, propId: string): Promise<void> {
  await repo.removeProperty(db, propId);
}
```

- [ ] **Step 6: Move the zod bodies into the module**

Create `api/src/modules/schemas/schemas.ts` by copying `api/src/routes/v1/ontology.ts` lines 10–95 verbatim (all zod declarations plus `PropertyFeatureEnum`, `TripleTemplateBody`, `IdParam`, `ClassIdParam`, `PropIdParam`), exporting each. Do not weaken a single validator. Leave the original file untouched — Task 6 moves it to `legacy/`.

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm test -w sulo-schema-builder-api -- src/modules/schemas/repo.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck -w sulo-schema-builder-api
git add -A
git commit -m "feat(api): Postgres schemas repository and service

Feature-parity CRUD over Kysely with the SQLite path's exact PATCH
semantics, IRI minting and jsonb round-tripping, covered by
Testcontainers tests."
```

---

### Task 6: Routes, mode switch, and freezing the SQLite path

**Files:**
- Create: `api/src/modules/schemas/routes.ts`, `api/src/modules/schemas/routes.test.ts`, `api/src/config/index.ts`, `api/src/config/server.ts`, `api/src/config/db.ts`, `api/src/config/reasoner.ts`
- Move: `api/src/routes/v1/ontology.ts` → `api/src/legacy/sqlite/ontology.routes.ts`; `api/src/routes/v1/ontology.routes.test.ts` → `api/src/legacy/sqlite/ontology.routes.test.ts`; `api/src/db/connection.ts` → `api/src/legacy/sqlite/connection.ts`; `api/src/db/settings.ts` → `api/src/legacy/sqlite/settings.ts`; `api/src/plugins/db.ts` → `api/src/legacy/sqlite/plugin.ts`
- Modify: `api/src/config.ts` (becomes a re-export shim, then is deleted), `api/src/server.ts`, `api/src/routes/v1/index.ts`, `api/src/routes/v1/upperConcepts.ts` (import path only), `api/src/services/java.service.ts` + `sulo.service.ts` (settings import path only), `docker-compose.yml`, `docker/api/Dockerfile`, `README.md`
- Test: `api/src/modules/schemas/routes.test.ts`, plus the moved legacy suite

**Interfaces:**
- Consumes: `service.*` and the zod bodies from Task 5; `fastify.pg` from Task 4.
- Produces: `schemasRoutes: FastifyPluginAsync` mounted at `/api/v1/ontology-schemas` when `config.storage === 'postgres'`, exposing exactly today's endpoints: `GET /`, `GET /:id`, `POST /`, `PATCH /:id`, `DELETE /:id`, `GET /:id/upper-concepts`, `POST /:id/classes`, `PATCH /:id/classes/:classId`, `DELETE /:id/classes/:classId`, `POST /:id/properties`, `PATCH /:id/properties/:propId`, `DELETE /:id/properties/:propId`. Also `config.storage: 'postgres' | 'sqlite'`.

- [ ] **Step 1: Write the failing route test**

Create `api/src/modules/schemas/routes.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { startTestDb, truncateAll, type TestDb } from '../../../test/pg.js';
import schemasRoutes from './routes.js';

let t: TestDb;
let app: FastifyInstance;

beforeAll(async () => {
  t = await startTestDb();
  app = Fastify();
  await app.register(sensible);
  app.decorate('pg', t.db);
  await app.register(schemasRoutes, { prefix: '/ontology-schemas' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await t.stop();
});

beforeEach(async () => { await truncateAll(t.db); });

describe('ontology-schemas routes (postgres)', () => {
  it('creates a schema with empty classes/properties', async () => {
    const res = await app.inject({
      method: 'POST', url: '/ontology-schemas', payload: { title: 'Test Schema', description: 'desc' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ title: 'Test Schema', description: 'desc', classes: [], properties: [] });
    expect(body.url).toContain(body.id);
  });

  it('lists schemas ordered by title', async () => {
    await app.inject({ method: 'POST', url: '/ontology-schemas', payload: { title: 'Zebra' } });
    await app.inject({ method: 'POST', url: '/ontology-schemas', payload: { title: 'Alpha' } });

    const body = (await app.inject({ method: 'GET', url: '/ontology-schemas' })).json();
    expect(body.map((s: { title: string }) => s.title)).toEqual(['Alpha', 'Zebra']);
  });

  it('404s on a missing schema', async () => {
    const res = await app.inject({
      method: 'GET', url: '/ontology-schemas/11111111-1111-1111-1111-111111111111',
    });
    expect(res.statusCode).toBe(404);
  });

  it('400s on a malformed id instead of leaking a database error', async () => {
    const res = await app.inject({ method: 'GET', url: '/ontology-schemas/not-a-uuid' });
    expect(res.statusCode).toBe(400);
  });

  it('supports the full class/property CRUD flow with a mapping pattern', async () => {
    const schema = (await app.inject({
      method: 'POST', url: '/ontology-schemas', payload: { title: 'Family Ontology' },
    })).json();

    const parent = (await app.inject({
      method: 'POST', url: `/ontology-schemas/${schema.id}/classes`, payload: { name: 'Person' },
    })).json();
    const child = (await app.inject({
      method: 'POST', url: `/ontology-schemas/${schema.id}/classes`,
      payload: { name: 'Parent', superClassId: parent.id },
    })).json();

    const prop = (await app.inject({
      method: 'POST', url: `/ontology-schemas/${schema.id}/properties`,
      payload: {
        name: 'hasChild', propertyType: 'object', domainClassId: child.id, rangeClassIri: parent.url,
        mappingPattern: [{ subject: '?this', predicate: 'https://example.org/p', object: '?value' }],
        isRequired: true, propertyFeatures: ['functional'],
      },
    })).json();
    expect(prop.mappingPattern).toHaveLength(1);

    await app.inject({
      method: 'PATCH', url: `/ontology-schemas/${schema.id}/properties/${prop.id}`,
      payload: { label: 'has child', isRequired: false },
    });

    const full = (await app.inject({ method: 'GET', url: `/ontology-schemas/${schema.id}` })).json();
    expect(full.classes).toHaveLength(2);
    expect(full.properties[0]).toMatchObject({ label: 'has child', isRequired: false });

    expect((await app.inject({
      method: 'DELETE', url: `/ontology-schemas/${schema.id}/properties/${prop.id}`,
    })).statusCode).toBe(204);
    expect((await app.inject({
      method: 'DELETE', url: `/ontology-schemas/${schema.id}/classes/${child.id}`,
    })).statusCode).toBe(204);

    const after = (await app.inject({ method: 'GET', url: `/ontology-schemas/${schema.id}` })).json();
    expect(after.properties).toHaveLength(0);
    expect(after.classes).toHaveLength(1);
  });

  it('updates schema metadata via PATCH', async () => {
    const schema = (await app.inject({
      method: 'POST', url: '/ontology-schemas', payload: { title: 'Before' },
    })).json();

    expect((await app.inject({
      method: 'PATCH', url: `/ontology-schemas/${schema.id}`,
      payload: { title: 'After', description: 'new' },
    })).statusCode).toBe(204);

    const body = (await app.inject({ method: 'GET', url: `/ontology-schemas/${schema.id}` })).json();
    expect(body).toMatchObject({ title: 'After', description: 'new' });
  });

  it('normalizes baseUri on create and update, and returns it from list and single reads', async () => {
    const schema = (await app.inject({
      method: 'POST', url: '/ontology-schemas',
      payload: { title: 'Based', baseUri: 'https://example.org/ns' },
    })).json();
    expect(schema.baseUri).toBe('https://example.org/ns/');

    const list = (await app.inject({ method: 'GET', url: '/ontology-schemas' })).json();
    expect(list[0].baseUri).toBe('https://example.org/ns/');

    await app.inject({
      method: 'PATCH', url: `/ontology-schemas/${schema.id}`,
      payload: { baseUri: 'https://example.org/other#' },
    });
    const single = (await app.inject({ method: 'GET', url: `/ontology-schemas/${schema.id}` })).json();
    expect(single.baseUri).toBe('https://example.org/other#');
  });

  it('returns [] from upper-concepts when no upper ontology is set', async () => {
    const schema = (await app.inject({
      method: 'POST', url: '/ontology-schemas', payload: { title: 'No upper' },
    })).json();

    const res = await app.inject({ method: 'GET', url: `/ontology-schemas/${schema.id}/upper-concepts` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w sulo-schema-builder-api -- src/modules/schemas/routes.test.ts`
Expected: FAIL — `Cannot find module './routes.js'`.

- [ ] **Step 3: Write the routes**

Create `api/src/modules/schemas/routes.ts`:

```ts
// HTTP surface for schemas. Identical paths, payloads and status codes to the
// SQLite path this replaces; all persistence goes through service.ts.
//
// No authorization yet — every schema belongs to LOCAL_OWNER_ID until plan 2
// introduces authentication and the ACL guards.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { fetchUpperConcepts } from '../../rdf/upperConcepts.js';
import { LOCAL_OWNER_ID } from '../../db/constants.js';
import * as service from './service.js';
import {
  AddClassBody, AddPropertyBody, ClassIdParam, CreateOntologySchemaBody,
  IdParam, PropIdParam, UpdateClassBody, UpdateOntologySchemaBody, UpdatePropertyBody,
} from './schemas.js';

/** Route params are uuids in Postgres; a non-uuid is a client error, not a 500. */
const UuidParam = z.object({ id: z.string().uuid() });
const UuidClassParam = z.object({ id: z.string().uuid(), classId: z.string().uuid() });
const UuidPropParam = z.object({ id: z.string().uuid(), propId: z.string().uuid() });

const schemasRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async () => service.listSchemas(fastify.pg, LOCAL_OWNER_ID));

  fastify.get('/:id', async (request, reply) => {
    const parsed = UuidParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed schema id');

    const schema = await service.getSchemaWithChildren(fastify.pg, parsed.data.id);
    if (!schema) return reply.notFound(`OntologySchema ${parsed.data.id} not found`);
    return schema;
  });

  fastify.post('/', async (request, reply) => {
    const data = CreateOntologySchemaBody.parse(request.body);
    const created = await service.createSchema(fastify.pg, LOCAL_OWNER_ID, data);
    return reply.code(201).send(created);
  });

  fastify.patch('/:id', async (request, reply) => {
    const parsed = UuidParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed schema id');

    const data = UpdateOntologySchemaBody.parse(request.body);
    await service.updateSchema(fastify.pg, parsed.data.id, data);
    return reply.code(204).send();
  });

  fastify.delete('/:id', async (request, reply) => {
    const parsed = UuidParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed schema id');

    await service.deleteSchema(fastify.pg, parsed.data.id);
    return reply.code(204).send();
  });

  fastify.get('/:id/upper-concepts', async (request, reply) => {
    const parsed = UuidParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed schema id');

    const schema = await service.getSchemaWithChildren(fastify.pg, parsed.data.id);
    if (!schema) return reply.notFound(`OntologySchema ${parsed.data.id} not found`);
    if (!schema.upperOntologyIri) return [];
    return fetchUpperConcepts(schema.upperOntologyIri);
  });

  fastify.post('/:id/classes', async (request, reply) => {
    const parsed = UuidParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed schema id');

    const data = AddClassBody.parse(request.body);
    const created = await service.addClass(fastify.pg, parsed.data.id, data);
    return reply.code(201).send(created);
  });

  fastify.patch('/:id/classes/:classId', async (request, reply) => {
    const parsed = UuidClassParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed id');

    const data = UpdateClassBody.parse(request.body);
    await service.updateClass(fastify.pg, parsed.data.classId, data);
    return reply.code(204).send();
  });

  fastify.delete('/:id/classes/:classId', async (request, reply) => {
    const parsed = UuidClassParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed id');

    await service.deleteClass(fastify.pg, parsed.data.classId);
    return reply.code(204).send();
  });

  fastify.post('/:id/properties', async (request, reply) => {
    const parsed = UuidParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed schema id');

    const data = AddPropertyBody.parse(request.body);
    const created = await service.addProperty(fastify.pg, parsed.data.id, data);
    return reply.code(201).send(created);
  });

  fastify.patch('/:id/properties/:propId', async (request, reply) => {
    const parsed = UuidPropParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed id');

    const data = UpdatePropertyBody.parse(request.body);
    await service.updateProperty(fastify.pg, parsed.data.propId, data);
    return reply.code(204).send();
  });

  fastify.delete('/:id/properties/:propId', async (request, reply) => {
    const parsed = UuidPropParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed id');

    await service.deleteProperty(fastify.pg, parsed.data.propId);
    return reply.code(204).send();
  });
};

export default schemasRoutes;
```

The unused `IdParam`, `ClassIdParam`, `PropIdParam` imports exist because `schemas.ts` is a verbatim copy; delete those three from the import list if the linter flags them.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w sulo-schema-builder-api -- src/modules/schemas/routes.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Move the SQLite path into `legacy/`**

```bash
cd /home/ensar/workspace/03_ids/sulo-schema-builder-main
mkdir -p api/src/legacy/sqlite
git mv api/src/routes/v1/ontology.ts            api/src/legacy/sqlite/ontology.routes.ts
git mv api/src/routes/v1/ontology.routes.test.ts api/src/legacy/sqlite/ontology.routes.test.ts
git mv api/src/db/connection.ts                  api/src/legacy/sqlite/connection.ts
git mv api/src/db/settings.ts                    api/src/legacy/sqlite/settings.ts
git mv api/src/plugins/db.ts                     api/src/legacy/sqlite/plugin.ts
```

Fix the import paths in the moved files (`../../rdf/prefixes.js` → `../../rdf/prefixes.js` stays correct at this depth; `../config.js` becomes `../../config/index.js` after Step 6) and in the files that referenced them: `api/src/services/java.service.ts`, `api/src/services/sulo.service.ts` and `api/src/routes/v1/reason.ts` import `db/settings.js` — repoint each to `../legacy/sqlite/settings.js`. Add a header comment to `api/src/legacy/sqlite/ontology.routes.ts`:

```ts
// FROZEN: the single-user SQLite path used by the packaged desktop app.
// Bug fixes only — new features belong in api/src/modules/. See
// docs/superpowers/specs/2026-08-19-multi-user-backend-design.md §9.
```

- [ ] **Step 6: Split the config**

Create `api/src/config/server.ts` (env/port/host/logLevel/isPackaged/appDataDir/resourcesDir/staticDir/rateLimitEnabled/storage), `api/src/config/db.ts` (sqlite `path` plus the `postgres` block from Task 4), and `api/src/config/reasoner.ts` (the entire `reasoner` block, unchanged values), each exporting a named const. Then `api/src/config/index.ts`:

```ts
import { serverConfig } from './server.js';
import { dbConfig, postgresConfig } from './db.js';
import { reasonerConfig } from './reasoner.js';

export const config = {
  ...serverConfig,
  db: dbConfig,
  postgres: postgresConfig,
  reasoner: reasonerConfig,
} as const;
```

In `api/src/config/server.ts`, replace the temporary `storage` constant from Task 1 with the real switch:

```ts
// 'postgres' is the multi-user web deployment; 'sqlite' is the frozen
// single-user desktop path. Packaged desktop builds are always 'sqlite'.
const storage: 'postgres' | 'sqlite' =
  !isPackaged && optional('SCHEMA_STORAGE', 'sqlite') === 'postgres' ? 'postgres' : 'sqlite';
```

Delete `api/src/config.ts` and update every importer to `../config/index.js` (or the correct relative depth):

```bash
grep -rln "config\.js'" api/src | xargs -r grep -l "from '.*config\.js'"
```

Run that to enumerate the files, then fix each import.

- [ ] **Step 7: Wire both modes in the server**

`api/src/routes/v1/index.ts`:

```ts
import type { FastifyPluginAsync } from 'fastify';
import { config } from '../../config/index.js';
import healthRoute from './health.js';
import upperConceptsRoute from './upperConcepts.js';
import reasonRoutes from './reason.js';
import schemasRoutes from '../../modules/schemas/routes.js';
import legacySqliteRoutes from '../../legacy/sqlite/ontology.routes.js';

const v1Routes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(healthRoute);
  await fastify.register(upperConceptsRoute);
  await fastify.register(
    config.storage === 'postgres' ? schemasRoutes : legacySqliteRoutes,
    { prefix: '/ontology-schemas' },
  );
  await fastify.register(reasonRoutes, { prefix: '/reason' });
};

export default v1Routes;
```

In `api/src/server.ts`, register the matching data plugin:

```ts
import pgPlugin from './plugins/pg.js';
import sqlitePlugin from './legacy/sqlite/plugin.js';
// …
  await server.register(config.storage === 'postgres' ? pgPlugin : sqlitePlugin);
```

- [ ] **Step 8: Point the deployment at Postgres**

In `docker-compose.yml`, set `SCHEMA_STORAGE: postgres` on the `api` service and add a one-shot migrate service:

```yaml
  migrate:
    build:
      context: .
      dockerfile: docker/api/Dockerfile
    command: ["npm", "run", "migrate", "-w", "sulo-schema-builder-api"]
    environment:
      DATABASE_URL: postgres://sulo:${POSTGRES_PASSWORD:-sulo}@db:5432/sulo
    depends_on:
      db:
        condition: service_healthy
    networks:
      - sulo-net
    restart: "no"
```

and make the `api` service wait for it:

```yaml
    depends_on:
      db:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
```

In `docker/api/Dockerfile`, change `ENV SCHEMA_STORAGE=browser` (removed in Task 1) to `ENV SCHEMA_STORAGE=postgres`, and make sure the production stage keeps `tsx` available or add a compiled `dist/scripts/migrate.js` target for the migrate command — compile it by including `scripts/` in `api/tsconfig.json`'s `include` and using `command: ["node", "api/dist/scripts/migrate.js"]` instead.

Update the `README.md` storage-mode section: two modes, `postgres` (web, multi-user, the Docker default) and `sqlite` (frozen desktop path); document `DATABASE_URL`, `DATABASE_POOL_MAX`, `RATE_LIMIT_ENABLED`, and the `npm run migrate` step.

- [ ] **Step 9: Run every check, including the frozen path**

```bash
npm run build -w @sulo/schema-core
npm run typecheck
npm test
docker compose up -d --build
sleep 15
curl -sf localhost:8080/api/v1/health
curl -sf -X POST localhost:8080/api/v1/ontology-schemas \
  -H 'content-type: application/json' -d '{"title":"Smoke"}'
curl -sf localhost:8080/api/v1/ontology-schemas
docker compose down
node api/scripts/package-desktop.mjs
```

Expected: typechecks clean; all suites pass (including the moved legacy SQLite suite, unchanged); the container creates and lists a schema in Postgres; the desktop binary still builds.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(api): serve schemas from Postgres; freeze the SQLite path

SCHEMA_STORAGE selects modules/schemas (Postgres, multi-user-ready) or the
frozen legacy/sqlite path used by the desktop app. Config is split per
concern and compose gains a Postgres service plus a one-shot migrate step."
```

---

## Self-Review

**Spec coverage for this plan's stages (0–2):**

| Spec requirement | Task |
| --- | --- |
| §2 browser storage deleted | 1 |
| §2/§9 `SCHEMA_STORAGE` = `postgres`\|`sqlite` | 1 (removes `browser`), 6 (adds `postgres`) |
| §3 every table, index, check constraint | 4 (migration 001) |
| §3 no `sessions` table | 4 (absent by construction) |
| §3 versioned SQL migrations, explicit run | 4 (`migrate.ts`, `scripts/migrate.ts`, compose `migrate` service in 6) |
| §9 `packages/schema-core` extraction | 3 |
| §9 `modules/schemas` replaces `ontology.ts` | 5, 6 |
| §9 config split per concern | 6 |
| §9 `legacy/sqlite/` frozen path | 6 |
| §9 preserved files (safeFetch, robot, sulo, parsers, schemaTransfer) | untouched by every task; Global Constraints forbids edits |
| §11 Testcontainers for repo tests | 4 (harness), 5, 6 |
| §11 no data migration; transfer JSON is the escape hatch | 1 (schemaTransfer kept, retested) |

Deferred to later plans by design, not omission: `users` beyond the seeded row, ACL/grants enforcement, quotas, the reasoning queue and cache, SSE, admin routes. The tables for all of them ship in migration 001 so no later plan needs an `ALTER`.

**Type consistency checks performed:** `LOCAL_OWNER_ID` is defined in Task 4 and used in Tasks 5 and 6. `startTestDb`/`truncateAll` are defined in Task 4 and consumed in 5 and 6. `service.*` names in Task 6's routes match Task 5's exports exactly (`listSchemas`, `getSchemaWithChildren`, `createSchema`, `updateSchema`, `deleteSchema`, `addClass`, `updateClass`, `deleteClass`, `addProperty`, `updateProperty`, `deleteProperty`). `fastify.pg` is declared in Task 4's plugin and used in Task 6's routes and tests. `createFakeBackend` in Task 1 mirrors `backend.ts`'s exported surface from the same task.

---

## Plans that follow

- **Plan 2 — Identity and access control:** Keycloak container and realm export, `plugins/auth.ts` with JWKS verification and JIT user provisioning, frontend `keycloak-js` wiring, then `modules/acl` (visibility, grants, the resolver table test, 404-not-403), replacing `LOCAL_OWNER_ID` with the authenticated user. Spec §4, §5.
- **Plan 3 — Quotas and automatic reasoning:** tier table, `usage_events` accounting, the durable `reason_jobs` queue with `SKIP LOCKED` fair scheduling, the debouncer, content-hash report cache, report endpoints, and unregistering client-supplied-Turtle `/reason` in postgres mode. Spec §6, §7.
- **Plan 4 — Change publication and administration:** `LISTEN`/`NOTIFY` listener, SSE endpoint with ACL gating, the frontend invalidation hook, and the admin routes. Spec §8, §5 (admin surface).

Write each one when the prior plan lands — a plan written months ahead of its turn goes stale against the code it edits.
