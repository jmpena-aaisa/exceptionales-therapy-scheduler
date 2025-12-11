IMAGE ?= therapy-scheduler
TAG ?= latest
HYDRA_ARGS ?=

.PHONY: optimize docker-build docker-run run-local

optimize: docker-build docker-run

docker-build:
	docker build -t $(IMAGE):$(TAG) .

docker-run:
	docker run --rm \
		-v $(PWD)/output:/app/output \
		$(IMAGE):$(TAG) $(HYDRA_ARGS)

run-local:
	uv run python -m therapy_scheduler.main $(HYDRA_ARGS)
