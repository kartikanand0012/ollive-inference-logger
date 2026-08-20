variable "region" {
  type    = string
  default = "us-east-1"
}

variable "environment" {
  type    = string
  default = "prod"
}

variable "project" {
  type    = string
  default = "ollive"
}

variable "github_repo" {
  description = "GitHub org/repo allowed to deploy via OIDC, e.g. kartik/ollive-inference-logger"
  type        = string
}

variable "image_tag" {
  description = "Git SHA image tag to deploy"
  type        = string
  default     = "latest"
}

variable "db_password" {
  description = "Master password for RDS (feed from SSM/Secrets at apply time)"
  type        = string
  sensitive   = true
}

variable "anthropic_api_key_arn" {
  description = "SSM SecureString parameter ARN holding ANTHROPIC_API_KEY"
  type        = string
  default     = ""
}

# Services and their fixed shapes — one definition drives ECR + ECS.
variable "services" {
  type = map(object({ port = number, cpu = number, memory = number, public = bool }))
  default = {
    api    = { port = 4000, cpu = 512, memory = 1024, public = true }
    ingest = { port = 4318, cpu = 512, memory = 1024, public = true }
    worker = { port = 0, cpu = 512, memory = 1024, public = false }
    web    = { port = 3000, cpu = 256, memory = 512, public = true }
  }
}
