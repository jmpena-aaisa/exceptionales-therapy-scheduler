

<p align="center">
  <img src="logo.png" alt="Therapy Scheduler Logo" width="240"/>
</p>

# Therapy Scheduler

## 1. ¿Qué es?
Planificador semanal de terapias basado en optimización de restricciones (OR-Tools CP-SAT). Asigna pacientes, terapeutas y salas en bloques de 1 hora (lun-vie, 08-18 con almuerzo) cumpliendo terapias (cada terapia define composición de especialidades y min/max pacientes), disponibilidades, cupos por sala y guías terapéuticas (máx. horas continuas, evitar doble booking, etc.).

## 2. Manual de uso
- **Configurar datos (Hydra por defecto):**
  - Terapeutas: `config/therapists/default.yaml`
    ```yaml
    therapists:
      - id: T1
        specialties: [kinesiology, phonoaudiology]
        availability:
          Monday: ["08:00-13:00", "14:00-18:00"]
          Wednesday: ["08:00-13:00", "14:00-18:00"]
    ```
  - Pacientes: `config/patients/default.yaml`
    ```yaml
    patients:
      - id: P1
        therapies: { play_group: 2, fono_group: 4 }
        no_same_day_therapies: []   # opcional
        availability:
          Monday: ["14:00-18:00"]
          Tuesday: ["08:00-18:00"]
        max_continuous_hours: 3
    ```
  - Salas: `config/rooms/default.yaml`
    ```yaml
    rooms:
      - id: R2
        therapies: [fono_group, play_group]
        capacity: 4
    ```
  - Especialidades: `config/specialties/default.yaml`
    ```yaml
    specialties: [phonoaudiology, kinesiology, occupational_therapy]
    ```
  - Terapias: `config/therapies/default.yaml`
    ```yaml
    therapies:
      - id: play_group
        requirements: { kinesiology: 2, phonoaudiology: 1 }
        min_patients: 2
        max_patients: 5
    ```
  - Objetivos: `config/objectives/default_objectives.yaml` (pesos de días de paciente e idle gaps de terapeuta).
- **Configurar por JSON (opcional):** establece `data.instance_path=path/a/archivo.json` (mismo esquema que el ejemplo en `data/schedule_params/sample_instance.json`). Si está `null`, se usan las configs Hydra.
- **Ejecutar en Docker (recomendado):**
  ```bash
  make optimize                     # build + run, persiste ./output
  make docker-run HYDRA_ARGS="solver.time_limit=20 objectives.patient_days_weight=2"
  ```
- **Ejecutar local:**
  ```bash
  uv pip install --system --editable .
  uv run python -m therapy_scheduler.main
  ```
- **Salida generada:**
  - JSON en `output/schedule.json` con `status`, `objective_value`, `schedule`, `diagnostics`.
  - Excel en `output/schedule.xlsx`:
    - Una pestaña por sala (días vs bloques).
    - Pestaña “Therapists” (columnas por terapeuta; celda: `especialidad | pacientes | terapeuta | sala | n=`).
    - Pestaña “Patients” (columnas por paciente; celda: `especialidad | pacientes | terapeuta | sala | n=`).

## 3. Sección técnica
- **Tecnología:** Python 3.11, OR-Tools CP-SAT, Hydra/OmegaConf, uv, openpyxl; Dockerfile listo; Makefile con targets `optimize`, `docker-run`, `run-local`.
- **Modelo y restricciones principales:**
  - Variables binarias de sesión activa por terapia–sala–día–bloque; asignación de pacientes a sesiones y staffing por terapeuta–especialidad–sesión.
  - Cobertura exacta de terapias requeridas por paciente (conteo de sesiones).
  - No solapamiento: paciente, terapeuta y sala a lo sumo una sesión por bloque.
  - Capacidad: min/max por terapia y capacidad de sala.
  - Máx. horas continuas por paciente (ventanas deslizantes).
  - `no_same_day_therapies`: a lo sumo una sesión diaria para esas terapias en el paciente.
  - Objetivo: minimizar días usados por pacientes + huecos de 1h en agenda de terapeutas (ponderados).
- **Layout del repo:**
  ```text
  .
  ├─ config/               # Hydra (therapists, patients, rooms, specialties, therapies, objectives)
  ├─ data/                 # Ejemplos JSON (opcional)
  ├─ output/               # Resultados (schedule.json, schedule.xlsx)
  ├─ src/therapy_scheduler # Código: modelo OR-Tools, main, writer Excel
  ├─ Dockerfile            # Imagen lista con uv
  ├─ Makefile              # Targets optimize, docker-run, run-local
  ├─ pyproject.toml        # Dependencias y entrypoint
  └─ uv.lock               # Lock de dependencias
  ```
- **Comandos clave:**
  ```bash
  make optimize                              # build + run en Docker, persiste ./output
  make docker-run HYDRA_ARGS="solver.time_limit=20"   # reusar imagen y pasar overrides Hydra
  make run-local HYDRA_ARGS="objectives.patient_days_weight=2"   # ejecutar con uv local
  ```

## Run with Docker
```bash
make optimize              # build image and run solver
make docker-run HYDRA_ARGS="solver.time_limit=10.0"  # pass Hydra overrides
```
The run target mounts `./output` so `output/schedule.json` persists on the host.

## Run locally (optional)
```bash
uv pip install --system --editable .
uv run python -m therapy_scheduler.main
```

## Configuration
- Problem instance path: `config/config.yaml` → `data.instance_path`
- Objective weights: `config/objectives/default_objectives.yaml`
- Solver options: `config/config.yaml` (`solver.time_limit`, `solver.log_search_progress`)
- Patient optional constraint: `no_same_day_therapies` disallows multiple sessions of listed therapies on the same day for that patient.

You can override any config key via Hydra CLI syntax, e.g.:
```bash
uv run python -m therapy_scheduler.main objectives.patient_days_weight=2 solver.time_limit=20
```
