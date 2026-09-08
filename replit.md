# Replit-to-Local

A web tool that converts a Replit `.zip` export into a locally runnable project — with startup scripts, env templates, and a detailed README. No Replit dependency required.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm --filter @workspace/replit-to-local run dev` — run the frontend (port auto-assigned)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 + Multer (file uploads) + AdmZip (zip handling) + smol-toml (TOML parsing)
- Frontend: React + Vite + Tailwind CSS + TanStack Query (status polling)
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/lib/convert/` — the full conversion pipeline
  - `pipeline.ts` — main orchestrator, runs all steps in sequence
  - `parse-replit.ts` — parses `.replit` TOML (run command, env, modules, nix packages)
  - `detect-stack.ts` — detects Node/Python/hybrid, scans for env keys, DB usage, orphaned scripts, @replit/* imports
  - `generate-output.ts` — generates `run.sh`, `run.bat`, `.env.example`, `README.md`
  - `store.ts` — in-memory job store plus persistent JSONL storage for conversion reports
  - `types.ts` — shared TypeScript types
- `artifacts/api-server/src/routes/convert.ts` — upload, status, download routes
- `artifacts/replit-to-local/src/` — React frontend (single page: upload → log → download)
- `lib/api-spec/openapi.yaml` — API contract (status endpoint only; upload/download are raw Express)

## Architecture decisions

- File upload is handled by raw `multer` Express middleware (not in the OpenAPI spec) to avoid Orval codegen issues with `multipart/form-data` and `File`/`Blob` types
- The download endpoint (`GET /api/convert/:jobId/download`) is also a raw Express route (not in the spec) since it streams a binary zip
- Conversion jobs are stored in-memory — fine for v1; submitted issue reports are appended to `data/conversion-reports.jsonl` and exposed internally through `listConversionIssueReports()`
- The pipeline runs fully async; the upload endpoint returns immediately with a `jobId` and the frontend polls `/status` every 1.5s
- `pyproject.toml` parsing ignores `[tool.uv.sources]` (thousands of index mappings added by uv on Replit) — only `[project.dependencies]` and `[tool.poetry.dependencies]` are read

## Product

Upload a `.zip` exported from Replit → get back a clean `.zip` with:
- `run.sh` (Mac/Linux) and `run.bat` (Windows) — one-click startup scripts
- `.env.example` — all detected env variable keys, no values
- `README.md` — auto-generated: DB requirements, orphaned scripts, @replit/* warnings, detected stack

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Don't pass `multipart/form-data` file uploads through the OpenAPI spec — Orval generates `File`/`Blob` types that fail in Node's lib compilation target
- The `smol-toml` parser is used (ESM-native); `@iarna/toml` is an alternative if issues arise
- After changing the OpenAPI spec, always run `pnpm --filter @workspace/api-spec run codegen` before building
