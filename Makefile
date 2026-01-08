IMAGE ?= therapy-scheduler
TAG ?= latest
HYDRA_ARGS ?=
UI_DIR ?= ui
UI_NPM ?= npm

.PHONY: optimize docker-build docker-run run-local ui-install ui-build ui-dev ui-preview

optimize: docker-build docker-run

docker-build:
	docker build -t $(IMAGE):$(TAG) .

docker-run:
	docker run --rm \
		-v $(PWD)/output:/app/output \
		$(IMAGE):$(TAG) $(HYDRA_ARGS)

run-local:
	uv run python -m therapy_scheduler.main $(HYDRA_ARGS)

api:
	PYTHONPATH=src uv run uvicorn therapy_scheduler.api:app --reload --host 0.0.0.0 --port 8000

ui-install:
	cd $(UI_DIR) && $(UI_NPM) install

ui-build: ui-install
	cd $(UI_DIR) && $(UI_NPM) run build

ui-dev: ui-install
	cd $(UI_DIR) && $(UI_NPM) run dev

ui-preview: ui-install
	cd $(UI_DIR) && $(UI_NPM) run preview
