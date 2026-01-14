variable "project_id" {
  type = string
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "service_name" {
  type    = string
  default = "therapy-scheduler-api"
}

variable "data_bucket_name" {
  type = string
}

variable "ui_bucket_name" {
  type    = string
  default = ""
}

variable "ui_bucket_public" {
  type    = bool
  default = true
}

variable "artifact_repo_name" {
  type    = string
  default = "therapy-scheduler"
}

variable "image_name" {
  type    = string
  default = "therapy-scheduler-api"
}

variable "image_tag" {
  type    = string
  default = "latest"
}

variable "auth_secret" {
  type      = string
  sensitive = true
}

variable "require_auth" {
  type    = bool
  default = true
}

variable "token_ttl_seconds" {
  type    = number
  default = 3600
}

variable "gcs_prefix" {
  type    = string
  default = ""
}

variable "users_path" {
  type    = string
  default = "users/users.csv"
}

variable "allow_unauthenticated" {
  type    = bool
  default = true
}

variable "max_instances" {
  type    = number
  default = 1
}

variable "min_instances" {
  type    = number
  default = 0
}

variable "cpu" {
  type    = string
  default = "1"
}

variable "memory" {
  type    = string
  default = "1Gi"
}

variable "request_timeout" {
  type    = string
  default = "120s"
}

variable "concurrency" {
  type    = number
  default = 1
}
