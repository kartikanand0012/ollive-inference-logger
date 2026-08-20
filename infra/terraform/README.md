# Terraform — AWS reference deployment

AWS reference deployment (the "how this scales" story): VPC (3-AZ subnets, 1 NAT), RDS Postgres 16
Multi-AZ, MSK Provisioned 3× kafka.t3.small (TLS + SASL/SCRAM, RF=3 defaults),
ElastiCache Valkey (cancel bus), ECS Fargate (ARM) for api/ingest/worker/web,
ALB with path routing + WAF (managed rules + per-IP rate rule), ECR
(immutable tags), GitHub-OIDC deploy role.

Status: **`tofu validate`-clean scaffold — not yet applied to an account.**
Before first apply:
1. Create the S3 state bucket, uncomment the backend block.
2. `tofu apply -var github_repo=<org/repo> -var db_password=$(…from SSM…)`.
3. Wire MSK SASL/SCRAM credentials (AWS Secrets Manager association) and the
   internal service-discovery name for INGEST_URL (Cloud Map or internal ALB).
4. Add the ACM cert + :443 listener, flip :80 to redirect.
Known deliberate gaps are marked with comments inline.
