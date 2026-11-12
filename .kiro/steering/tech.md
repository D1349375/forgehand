# Tech stack

TypeScript (strict, ES2022 target, ESNext modules, Bundler resolution) throughout. ESM (`"type": "module"`). Node.js >= 22.12.

## Runtime & build
- **Vite 8** — frontend dev server and build (`@vitejs/plugin-react`).
- **tsx** — runs the TypeScript Express server directly (no compile step for `dev`/`start`).
- **tsc --noEmit** — type checking only; no JS is emitted. Paired with `vite build` for production.
- **Express 5** — local API server, loopback-only (`127.0.0.1`).
- **dotenv** — env config via `.env` (git-ignored; `.env.example` is the template).

## Key libraries
- **React 19** — UI (`react-jsx`).
- **Three.js 0.187** — WebGL 3D rendering (geometries, OrbitControls, scene graph).
- **Zod 4** — sole authority for all data validation. Schemas live in `shared/`, types derived with `z.infer`.
- **@mediapipe/tasks-vision 1.2.2** — hand and pose landmarkers, run in a web worker (GPU with CPU fallback).
- **supertest** — HTTP-level unit tests against the Express app.

## Commands
```
npm run dev        # Vite (HMR) + API server together
npm run build      # tsc --noEmit && vite build
npm start          # production server (serves dist)
npm test           # vitest run — unit tests (tests/unit)
npm run test:e2e   # playwright test — e2e (tests/e2e); run `npx playwright install chromium` first
npm run check      # build + unit tests
npm run verify:real   # calls the selected model back end on purpose (uses quota)
npm run verify:edit   # real-CLI edit verification (uses quota)
```

## Test conventions
- **Unit tests (Vitest)** run in Node, `maxWorkers: 1`, `isolate: false`. They inject a fake `ModelProvider` and never call a real model. Validate against `shared` schemas.
- **E2E tests (Playwright)** use a fake camera (`--use-fake-ui-for-media-stream`) and route interception for `/api/*`, but render the real Three.js WebGL scene (SwiftShader by default; `PLAYWRIGHT_GPU=1` opts into real GPU). `RUN_LIVE_CLI=1` opts into a real model service.
- `verify:real` / `verify:edit` are the only scripts that call a real back end; they write JSON to `artifacts/`.
