output "service_url" {
  value = google_cloud_run_v2_service.api.uri
}

output "data_bucket" {
  value = google_storage_bucket.data.name
}

output "ui_bucket" {
  value       = try(google_storage_bucket.ui[0].name, "")
  description = "UI bucket name (empty if not created)."
}

output "image_uri" {
  value = local.image_uri
}
