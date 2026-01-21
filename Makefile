IMAGE ?= therapy-scheduler
TAG ?= latest
HYDRA_ARGS ?=
UI_DIR ?= ui
UI_NPM ?= npm
API_BASE ?= http://localhost:8000
AUTH_EMAIL ?= text
AUTH_PASSWORD ?= 12345
AUTH_TOKEN ?=
API_TEST_INSTANCE ?= data/schedule_params/api_smoke_instance.json
TFVARS ?= infra/terraform/terraform.tfvars
TFVARS_EXAMPLE ?= infra/terraform/terraform.tfvars.example
TFVARS_SOURCE := $(firstword $(wildcard $(TFVARS)) $(TFVARS_EXAMPLE))
TF_PROJECT := $(shell sed -n 's/^project_id *= *"\(.*\)"/\1/p' $(TFVARS_SOURCE) | head -n 1)
TF_REGION := $(shell sed -n 's/^region *= *"\(.*\)"/\1/p' $(TFVARS_SOURCE) | head -n 1)
TF_DATA_BUCKET := $(shell sed -n 's/^data_bucket_name *= *"\(.*\)"/\1/p' $(TFVARS_SOURCE) | head -n 1)
TF_UI_BUCKET := $(shell sed -n 's/^ui_bucket_name *= *"\(.*\)"/\1/p' $(TFVARS_SOURCE) | head -n 1)
GCP_PROJECT ?= $(TF_PROJECT)
GCP_REGION ?= $(TF_REGION)
DATA_BUCKET ?= $(TF_DATA_BUCKET)
UI_BUCKET ?= $(TF_UI_BUCKET)
AR_REPO ?= therapy-scheduler
AR_IMAGE ?= therapy-scheduler-api
AR_TAG ?= latest
AR_IMAGE_URI ?= $(GCP_REGION)-docker.pkg.dev/$(GCP_PROJECT)/$(AR_REPO)/$(AR_IMAGE):$(AR_TAG)
TF_DIR ?= infra/terraform
TERRAFORM_APPLY_ARGS ?= -var image_tag=$(AR_TAG)

.PHONY: optimize docker-build docker-run run-local api api-build api-test api-image-push cloud-run-deploy ui-install ui-build ui-dev ui-preview ui-deploy

optimize: docker-build docker-run

docker-build:
	docker build -t $(IMAGE):$(TAG) .

api-build:
	@if [ -z "$(GCP_PROJECT)" ]; then echo "Set GCP_PROJECT before running this target."; exit 1; fi
	docker build -f Dockerfile.api -t $(AR_IMAGE_URI) .

docker-run:
	docker run --rm \
		-v $(PWD)/output:/app/output \
		$(IMAGE):$(TAG) $(HYDRA_ARGS)

run-local:
	uv run python -m therapy_scheduler.main $(HYDRA_ARGS)

api:
	PYTHONPATH=src uv run uvicorn therapy_scheduler.api:app --reload --host 0.0.0.0 --port 8000

api-image-push:
	@if [ -z "$(GCP_PROJECT)" ]; then echo "Set GCP_PROJECT before running this target."; exit 1; fi
	@docker buildx create --name cr-builder --use 2>/dev/null || docker buildx use cr-builder
	@docker buildx inspect --bootstrap >/dev/null
	docker buildx build --platform linux/amd64 -f Dockerfile.api -t $(AR_IMAGE_URI) --push .

cloud-run-deploy:
	@if [ -z "$(GCP_PROJECT)" ]; then echo "Set GCP_PROJECT before running this target."; exit 1; fi
	$(MAKE) api-image-push
	terraform -chdir=$(TF_DIR) init
	terraform -chdir=$(TF_DIR) apply $(TERRAFORM_APPLY_ARGS)

api-test:
	@set -e; \
	API_BASE="$(API_BASE)"; \
	TOKEN="$(AUTH_TOKEN)"; \
	if [ -z "$$TOKEN" ] && [ -n "$(AUTH_EMAIL)" ] && [ -n "$(AUTH_PASSWORD)" ]; then \
		echo "Logging in..."; \
		TOKEN=$$(curl -sS -X POST "$$API_BASE/api/login" \
			-H "Content-Type: application/json" \
			-d '{"email":"$(AUTH_EMAIL)","password":"$(AUTH_PASSWORD)"}' | \
			node -e 'const fs=require("fs");const input=fs.readFileSync(0,"utf8");const data=JSON.parse(input||"{}");if(!data.token){console.error("No token in response");process.exit(1)};process.stdout.write(data.token)'); \
	fi; \
	if [ -n "$$TOKEN" ]; then \
		echo "Running model (auth)..."; \
		node -e 'const fs=require("fs");const raw=JSON.parse(fs.readFileSync("$(API_TEST_INSTANCE)","utf8"));const toArray=(v)=>Array.isArray(v)?v:[];const specialties=toArray(raw.specialties).map((item)=>typeof item==="string"?{id:item}:{id:String(item.id||"")}).filter((s)=>s.id);const therapies=toArray(raw.therapies).map((t)=>{const minPatients=t.minPatients ?? t.min_patients ?? 1;const maxPatients=t.maxPatients ?? t.max_patients ?? 1;const {min_patients,max_patients,...rest}=t;return {...rest,minPatients,maxPatients};});const patients=toArray(raw.patients).map((p)=>{const maxContinuousHours=p.maxContinuousHours ?? p.max_continuous_hours;const noSameDayTherapies=p.noSameDayTherapies ?? p.no_same_day_therapies ?? [];const fixedTherapists=p.fixedTherapists ?? p.fixed_therapists ?? {};const {max_continuous_hours,no_same_day_therapies,fixed_therapists,...rest}=p;return {...rest,...(maxContinuousHours!==undefined?{maxContinuousHours}:{}),noSameDayTherapies,fixedTherapists};});const entities={...raw,specialties,therapies,patients};process.stdout.write(JSON.stringify({entities}));' | \
			curl -sS -X POST "$$API_BASE/api/run" \
				-H "Authorization: Bearer $$TOKEN" \
				-H "Content-Type: application/json" \
				-d @-; \
		echo; \
		echo "Fetching results (auth)..."; \
		curl -sS "$$API_BASE/api/results" \
			-H "Authorization: Bearer $$TOKEN"; \
		echo; \
		echo "Downloading Excel to schedule.xlsx (auth)..."; \
		curl -sS -o schedule.xlsx "$$API_BASE/api/download/excel" \
			-H "Authorization: Bearer $$TOKEN"; \
	else \
		echo "Running model (no auth)..."; \
		node -e 'const fs=require("fs");const raw=JSON.parse(fs.readFileSync("$(API_TEST_INSTANCE)","utf8"));const toArray=(v)=>Array.isArray(v)?v:[];const specialties=toArray(raw.specialties).map((item)=>typeof item==="string"?{id:item}:{id:String(item.id||"")}).filter((s)=>s.id);const therapies=toArray(raw.therapies).map((t)=>{const minPatients=t.minPatients ?? t.min_patients ?? 1;const maxPatients=t.maxPatients ?? t.max_patients ?? 1;const {min_patients,max_patients,...rest}=t;return {...rest,minPatients,maxPatients};});const patients=toArray(raw.patients).map((p)=>{const maxContinuousHours=p.maxContinuousHours ?? p.max_continuous_hours;const noSameDayTherapies=p.noSameDayTherapies ?? p.no_same_day_therapies ?? [];const fixedTherapists=p.fixedTherapists ?? p.fixed_therapists ?? {};const {max_continuous_hours,no_same_day_therapies,fixed_therapists,...rest}=p;return {...rest,...(maxContinuousHours!==undefined?{maxContinuousHours}:{}),noSameDayTherapies,fixedTherapists};});const entities={...raw,specialties,therapies,patients};process.stdout.write(JSON.stringify({entities}));' | \
			curl -sS -X POST "$$API_BASE/api/run" \
				-H "Content-Type: application/json" \
				-d @-; \
		echo; \
		echo "Fetching results (no auth)..."; \
		curl -sS "$$API_BASE/api/results"; \
		echo; \
		echo "Downloading Excel to schedule.xlsx (no auth)..."; \
		curl -sS -o schedule.xlsx "$$API_BASE/api/download/excel"; \
	fi; \
	echo; \
	echo "Done."

ui-install:
	cd $(UI_DIR) && $(UI_NPM) install

ui-build: ui-install
	cd $(UI_DIR) && $(UI_NPM) run build

ui-dev: ui-install
	cd $(UI_DIR) && $(UI_NPM) run dev

ui-preview: ui-install
	cd $(UI_DIR) && $(UI_NPM) run preview

ui-deploy:
	@API_URL="$(VITE_API_BASE)"; \
	if [ -z "$$API_URL" ]; then \
		API_URL=$$(terraform -chdir=$(TF_DIR) output -raw service_url 2>/dev/null); \
	fi; \
	if [ -z "$$API_URL" ]; then \
		echo "Set VITE_API_BASE or ensure terraform output service_url is available."; exit 1; \
	fi; \
	if [ -z "$(UI_BUCKET)" ]; then \
		echo "Set UI_BUCKET or ui_bucket_name in $(TFVARS_SOURCE)."; exit 1; \
	fi; \
	VITE_API_BASE="$$API_URL" $(MAKE) ui-build; \
	gcloud storage rsync -r $(UI_DIR)/dist gs://$(UI_BUCKET)
