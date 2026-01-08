# Therapy Scheduler UI

React + Vite + shadcn-style components for managing entities, importing/exporting JSON, running the solver, and previewing the schedule.

## Quick start
1. `cd ui`
2. `npm install`
3. Start the API: `cd .. && make api` (FastAPI + uvicorn on port 8000).
4. `VITE_API_BASE=http://localhost:8000 npm run dev` and open the URL from the console.

## Features
- CRUD tabs for therapists, patients, rooms, specialties.
- Import/export entities as JSON (localStorage-backed for now).
- Run model against the API and show status; results come from the backend solver.
- Results viewer by room/therapist/patient; download current `schedule.json` or `schedule.xlsx` (from `output/`).

## Wiring to the backend
- Backend endpoints expected (see `therapy_scheduler/api.py`):
  - `POST /api/run` `{ entities, timeLimit?, patientDaysWeight?, therapistIdleGapWeight? }` → schedule result.
  - `GET /api/results` → last schedule result.
  - `GET /api/download/excel` → Excel file.
- Keep the import/export schema consistent with `data/schedule_params/sample_instance.json`.

## Structure
- `src/lib/schema.ts` — Zod schemas and types for entities and schedules.
- `src/lib/api.ts` — import/export helpers, run-model stub, Excel download.
- `src/components/features` — entities CRUD, run-model panel, results viewer.
- `src/components/ui` — minimal shadcn-style primitives.
