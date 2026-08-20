terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
  }
  # Phase 0: create the state bucket first, then uncomment (S3-native locking).
  # backend "s3" {
  #   bucket       = "ollive-terraform-state"
  #   key          = "prod/terraform.tfstate"
  #   region       = "us-east-1"
  #   use_lockfile = true
  # }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = "ollive-inference-logger", Environment = var.environment, ManagedBy = "terraform" }
  }
}
