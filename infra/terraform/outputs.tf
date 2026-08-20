output "alb_dns" {
  value = aws_lb.this.dns_name
}

output "ecr_repos" {
  value = { for k, r in aws_ecr_repository.svc : k => r.repository_url }
}

output "msk_bootstrap_sasl" {
  value = aws_msk_cluster.this.bootstrap_brokers_sasl_scram
}

output "rds_endpoint" {
  value = module.rds.db_instance_address
}

output "valkey_endpoint" {
  value = aws_elasticache_replication_group.valkey.primary_endpoint_address
}

output "deploy_role_arn" {
  value = aws_iam_role.deploy.arn
}
