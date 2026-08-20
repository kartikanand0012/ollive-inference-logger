# VPC: 2 AZs for tasks/RDS, 3 broker subnets for MSK (needs distinct AZs).
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.16"

  name = "${var.project}-${var.environment}"
  cidr = "10.40.0.0/16"

  azs             = ["${var.region}a", "${var.region}b", "${var.region}c"]
  public_subnets  = ["10.40.0.0/20", "10.40.16.0/20"]
  private_subnets = ["10.40.64.0/20", "10.40.80.0/20", "10.40.96.0/20"]

  enable_nat_gateway = true
  single_nat_gateway = true # one NAT to start; add per-AZ NATs when HA matters
  enable_dns_support = true
  enable_dns_hostnames = true
}

module "alb_sg" {
  source  = "terraform-aws-modules/security-group/aws"
  version = "~> 5.2"
  name    = "${var.project}-alb"
  vpc_id  = module.vpc.vpc_id

  ingress_cidr_blocks = ["0.0.0.0/0"]
  ingress_rules       = ["https-443-tcp", "http-80-tcp"]
  egress_rules        = ["all-all"]
}

module "app_sg" {
  source  = "terraform-aws-modules/security-group/aws"
  version = "~> 5.2"
  name    = "${var.project}-apps"
  vpc_id  = module.vpc.vpc_id

  computed_ingress_with_source_security_group_id = [
    { rule = "all-tcp", source_security_group_id = module.alb_sg.security_group_id },
  ]
  number_of_computed_ingress_with_source_security_group_id = 1
  ingress_with_self = [{ rule = "all-tcp" }] # app↔app (api→ingest)
  egress_rules      = ["all-all"]
}

module "data_sg" {
  source  = "terraform-aws-modules/security-group/aws"
  version = "~> 5.2"
  name    = "${var.project}-data"
  vpc_id  = module.vpc.vpc_id

  computed_ingress_with_source_security_group_id = [
    { rule = "postgresql-tcp", source_security_group_id = module.app_sg.security_group_id },
    { rule = "kafka-broker-tls-tcp", source_security_group_id = module.app_sg.security_group_id },
    { rule = "redis-tcp", source_security_group_id = module.app_sg.security_group_id },
  ]
  number_of_computed_ingress_with_source_security_group_id = 3
  egress_rules = ["all-all"]
}
