# GCP Minimal Deployment (Cloud Run + GCS)

## Prereqs
- GCP project with billing enabled.
- `gcloud`, `docker`, and `terraform` installed.
- Authenticated locally:
  - `gcloud auth login`
  - `gcloud auth application-default login`

## Build + push the API image
```bash
export PROJECT_ID="your-project-id"
export REGION="us-central1"
export REPO="therapy-scheduler"
export IMAGE="therapy-scheduler-api"
export TAG="latest"

gcloud auth configure-docker "${REGION}-docker.pkg.dev"
docker build -f Dockerfile.api -t "${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${IMAGE}:${TAG}" .
docker push "${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${IMAGE}:${TAG}"
```

## Terraform apply
Create `infra/terraform/terraform.tfvars`:
```hcl
project_id        = "your-project-id"
region            = "us-central1"
data_bucket_name  = "therapy-scheduler-data-yourproject"
ui_bucket_name    = "therapy-scheduler-ui-yourproject"
auth_secret       = "change-this-long-random-string"
```

Then:
```bash
cd infra/terraform
terraform init
terraform apply
```

Terraform outputs the Cloud Run URL and the image URI it expects.

## Secure defaults
- `SCHEDULER_REQUIRE_AUTH=true` is enabled in Terraform.
- Data bucket enforces `public_access_prevention` and only expires `sessions/` objects.
- Lock CORS in `src/therapy_scheduler/api.py` to your UI domain before production.

## Deploy the UI (optional)
Build the UI with the API base URL and sync to the UI bucket:
```bash
cd ui
VITE_API_BASE=<CLOUD_RUN_URL> npm install
VITE_API_BASE=<CLOUD_RUN_URL> npm run build
gcloud storage rsync -r dist gs://<ui-bucket>
```

If `ui_bucket_name` is empty, the UI bucket is not created.

## Upload users.csv
Create a CSV with headers:
```csv
user_id,email,password_hash,created_at,disabled
```

User IDs must be 1-64 characters from `A-Z`, `a-z`, `0-9`, `_`, `-`.

Generate a password hash locally:
```bash
python - <<'PY'
from therapy_scheduler.auth import hash_password
print(hash_password("change-me"))
PY
```

Example row:
```csv
u_001,ana@example.com,pbkdf2_sha256$240000$...,2024-01-01T00:00:00Z,false
```

Upload it to the data bucket:
```bash
gcloud storage cp users.csv gs://<data-bucket>/users/users.csv
```

## Test the API
```bash
curl -X POST "<CLOUD_RUN_URL>/api/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"ana@example.com","password":"change-me"}'
```

Use the returned token:
```bash
curl -X POST "<CLOUD_RUN_URL>/api/run" \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d @data/schedule_params/sample_instance.json
```
