

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

## Ejecutar con Docker
```bash
make optimize              # build image and run solver
make docker-run HYDRA_ARGS="solver.time_limit=10.0"  # pass Hydra overrides
```
El target monta `./output` para que `output/schedule.json` persista en el host.

## Ejecutar local (opcional)
```bash
uv pip install --system --editable .
uv run python -m therapy_scheduler.main
```

### Backend API local (FastAPI)
En una terminal:
```bash
make api
```

### UI local (Vite)
En otra terminal:
```bash
cd ui
VITE_API_BASE=http://localhost:8000 npm install
VITE_API_BASE=http://localhost:8000 npm run dev
```

### Autenticación (UI y API)
- La UI muestra un botón de **Iniciar sesión** arriba a la derecha.  
  Sin login, el resto de los paneles queda oculto.
- El backend valida contra `users/users.csv` (local) o `gs://<data-bucket>/users/users.csv` (GCS).
- Las entidades se guardan por usuario en `users/<user_id>/entities.json` dentro del bucket de datos.
- Endpoint de login:
  ```text
  POST /api/login  { "email": "...", "password": "..." }
  ```
  Devuelve un token tipo Bearer; úsalo en:
  ```text
  Authorization: Bearer <TOKEN>
  ```

## Configuración
- Ruta de instancia: `config/config.yaml` → `data.instance_path`
- Pesos del objetivo: `config/objectives/default_objectives.yaml`
- Opciones del solver: `config/config.yaml` (`solver.time_limit`, `solver.log_search_progress`)
- Restricción opcional de paciente: `no_same_day_therapies` evita múltiples sesiones del mismo día para esas terapias.

Puedes overridear cualquier clave de config con Hydra CLI, por ejemplo:
```bash
uv run python -m therapy_scheduler.main objectives.patient_days_weight=2 solver.time_limit=20
```

## Despliegue (GCP, desde cero)
Este es un flujo reproducible y basado en comandos, desde una cuenta nueva de GCP hasta la app funcionando.

### 0) Requisitos previos
- Instalar: `gcloud`, `docker`, `terraform`, `node` (para build de UI).
- Iniciar sesión en la cuenta correcta:
  ```bash
  gcloud auth login
  gcloud auth application-default login
  ```

### 1) Crear un proyecto de GCP y habilitar facturación
- Crear un proyecto nuevo en la consola de GCP y vincular facturación.
- Setear el proyecto y región activos localmente:
  ```bash
  export PROJECT_ID="your-project-id"
  export REGION="southamerica-west1"
  gcloud config set project "$PROJECT_ID"
  ```

### 2) Elegir nombres de buckets (deben ser únicos globalmente)
Define dos nombres:
- Bucket de datos: sesiones y `users.csv`
- Bucket de UI: frontend estático

Ejemplo:
```bash
export DATA_BUCKET="exceptionales-scheduler-data-<unique>"
export UI_BUCKET="exceptionales-scheduler-ui-<unique>"
```

### 3) Crear variables de Terraform
Crear `infra/terraform/terraform.tfvars`:
```hcl
project_id       = "your-project-id"
region           = "southamerica-west1"
data_bucket_name = "your-data-bucket"
ui_bucket_name   = "your-ui-bucket"
auth_secret      = "your-long-random-secret"
image_tag        = "latest"
```

Generar un secreto fuerte:
```bash
openssl rand -hex 32
```

### 4) Build y push de la imagen API (linux/amd64)
Autenticar Docker contra Artifact Registry:
```bash
gcloud auth configure-docker "${REGION}-docker.pkg.dev"
```

Usa el target de Make (buildx + amd64). Para forzar un nuevo despliegue, usa un tag nuevo:
```bash
export IMAGE_TAG="$(date +%Y%m%d%H%M%S)"
GCP_PROJECT="$PROJECT_ID" \
GCP_REGION="$REGION" \
AR_REPO="therapy-scheduler" \
AR_IMAGE="therapy-scheduler-api" \
AR_TAG="$IMAGE_TAG" \
make api-image-push
```

### 5) Crear la infraestructura (Cloud Run + buckets)
```bash
cd infra/terraform
terraform init
terraform apply
```

Atajo recomendado (push + terraform apply):
```bash
export IMAGE_TAG="$(date +%Y%m%d%H%M%S)"
GCP_PROJECT="$PROJECT_ID" \
GCP_REGION="$REGION" \
AR_REPO="therapy-scheduler" \
AR_IMAGE="therapy-scheduler-api" \
AR_TAG="$IMAGE_TAG" \
make cloud-run-deploy
```

Obtener la URL de Cloud Run:
```bash
terraform output -raw service_url
```

### 6) Crear users.csv y subirlo
Crear un archivo con este header:
```csv
user_id,email,password_hash,created_at,disabled
```

Puedes partir desde el ejemplo:
```bash
cp users/users.example.csv users/users.csv
```

Generar un hash de password:
```bash
python - <<'PY'
from therapy_scheduler.auth import hash_password
print(hash_password("change-me"))
PY
```

Ejemplo:
```csv
u_001,ana@example.com,pbkdf2_sha256$240000$...,2024-01-01T00:00:00Z,false
```

Subir a GCS:
```bash
gcloud storage cp users/users.csv gs://your-data-bucket/users/users.csv
```

### 7) Build y despliegue de la UI (estática)
Usa la URL de Cloud Run como API base:
```bash
cd ui
VITE_API_BASE=<CLOUD_RUN_URL> npm install
VITE_API_BASE=<CLOUD_RUN_URL> npm run build
gcloud storage rsync -r dist gs://your-ui-bucket
```

Abrir la UI:
```text
https://storage.googleapis.com/your-ui-bucket/index.html
```

### 8) Prueba rápida
Inicia sesión con tu usuario y ejecuta el modelo. La API persiste:
- `sessions/<user>/<session>/request.json`
- `sessions/<user>/<session>/schedule.json`
- `sessions/<user>/<session>/schedule.xlsx`

### Limpieza / rollback
Si necesitas desmontar todo:
```bash
gcloud storage rm -r gs://your-ui-bucket/**
gcloud storage rm -r gs://your-data-bucket/**
cd infra/terraform
terraform destroy
```

Si `terraform destroy` falla por imágenes en Artifact Registry, elimina el repo con:
```bash
gcloud artifacts repositories delete therapy-scheduler \
  --location "$REGION" \
  --delete-contents
```

### Notas
- Cloud Run usa `SCHEDULER_REQUIRE_AUTH=true` por defecto en Terraform.
- El bucket de datos es privado (public access prevention).
- Antes de producción, restringe CORS en `src/therapy_scheduler/api.py` al dominio de la UI.
