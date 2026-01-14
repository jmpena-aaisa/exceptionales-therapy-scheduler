terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.20, < 6"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  image_uri = "${var.region}-docker.pkg.dev/${var.project_id}/${var.artifact_repo_name}/${var.image_name}:${var.image_tag}"
}

resource "google_project_service" "run" {
  service            = "run.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "artifact_registry" {
  service            = "artifactregistry.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "storage" {
  service            = "storage.googleapis.com"
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "repo" {
  location      = var.region
  repository_id = var.artifact_repo_name
  format        = "DOCKER"
  depends_on    = [google_project_service.artifact_registry]
}

resource "google_storage_bucket" "data" {
  name                        = var.data_bucket_name
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      age = 90
      matches_prefix = ["sessions/"]
    }
  }
  depends_on = [google_project_service.storage]
}

resource "google_storage_bucket" "ui" {
  count                       = var.ui_bucket_name != "" ? 1 : 0
  name                        = var.ui_bucket_name
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = false

  website {
    main_page_suffix = "index.html"
    not_found_page   = "index.html"
  }
  depends_on = [google_project_service.storage]
}

resource "google_storage_bucket_iam_member" "ui_public" {
  count  = var.ui_bucket_name != "" && var.ui_bucket_public ? 1 : 0
  bucket = google_storage_bucket.ui[0].name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}

resource "google_service_account" "api" {
  account_id   = "${var.service_name}-sa"
  display_name = "Therapy Scheduler API"
}

resource "google_storage_bucket_iam_member" "data_writer" {
  bucket = google_storage_bucket.data.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.api.email}"
}

resource "google_cloud_run_v2_service" "api" {
  name     = var.service_name
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.api.email
    timeout         = var.request_timeout
    max_instance_request_concurrency = var.concurrency

    containers {
      image = local.image_uri
      resources {
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }
      }

      env {
        name  = "SCHEDULER_STORAGE_BACKEND"
        value = "gcs"
      }
      env {
        name  = "SCHEDULER_GCS_BUCKET"
        value = google_storage_bucket.data.name
      }
      env {
        name  = "SCHEDULER_GCS_PREFIX"
        value = var.gcs_prefix
      }
      env {
        name  = "SCHEDULER_USERS_PATH"
        value = var.users_path
      }
      env {
        name  = "SCHEDULER_AUTH_SECRET"
        value = var.auth_secret
      }
      env {
        name  = "SCHEDULER_REQUIRE_AUTH"
        value = var.require_auth ? "true" : "false"
      }
      env {
        name  = "SCHEDULER_TOKEN_TTL_SECONDS"
        value = tostring(var.token_ttl_seconds)
      }
    }

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }
  }

  depends_on = [google_project_service.run]
}

resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  count    = var.allow_unauthenticated ? 1 : 0
  name     = google_cloud_run_v2_service.api.name
  location = google_cloud_run_v2_service.api.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}
