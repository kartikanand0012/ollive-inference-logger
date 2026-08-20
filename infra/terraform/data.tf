# ── Postgres: RDS 16, Multi-AZ ───────────────────────────────────────────────
module "rds" {
  source  = "terraform-aws-modules/rds/aws"
  version = "~> 6.10"

  identifier     = "${var.project}-${var.environment}"
  engine         = "postgres"
  engine_version = "16"
  family         = "postgres16"
  instance_class = "db.t4g.medium"

  allocated_storage = 100
  storage_type      = "gp3"
  multi_az          = true
  storage_encrypted = true

  db_name  = "ollive"
  username = "ollive"
  password = var.db_password
  manage_master_user_password = false
  port     = 5432

  vpc_security_group_ids = [module.data_sg.security_group_id]
  db_subnet_group_name   = module.vpc.database_subnet_group_name
  create_db_subnet_group = false
  subnet_ids             = module.vpc.private_subnets

  backup_retention_period    = 7
  deletion_protection        = true
  auto_minor_version_upgrade = true
  skip_final_snapshot        = false
}

# ── Kafka: MSK Provisioned 3× kafka.t3.small, RF=3-capable ──────────────────
resource "aws_msk_cluster" "this" {
  cluster_name           = "${var.project}-${var.environment}"
  kafka_version          = "3.8.x"
  number_of_broker_nodes = 3

  broker_node_group_info {
    instance_type   = "kafka.t3.small"
    client_subnets  = module.vpc.private_subnets
    security_groups = [module.data_sg.security_group_id]
    storage_info {
      ebs_storage_info { volume_size = 100 }
    }
  }

  encryption_info {
    encryption_in_transit {
      client_broker = "TLS"
      in_cluster    = true
    }
  }

  client_authentication {
    sasl { scram = true }
  }

  configuration_info {
    arn      = aws_msk_configuration.this.arn
    revision = aws_msk_configuration.this.latest_revision
  }
}

resource "aws_msk_configuration" "this" {
  name           = "${var.project}-${var.environment}"
  kafka_versions = ["3.8.x"]
  # Topics are created by the app's kafka-init with RF=3 in cloud;
  # auto-create stays off (same stance as compose).
  server_properties = <<-PROPS
    auto.create.topics.enable=false
    default.replication.factor=3
    min.insync.replicas=2
  PROPS
}

# ── Valkey: cancel-map pub/sub ───────────────────────────────────────────────
resource "aws_elasticache_subnet_group" "valkey" {
  name       = "${var.project}-valkey"
  subnet_ids = module.vpc.private_subnets
}

resource "aws_elasticache_replication_group" "valkey" {
  replication_group_id = "${var.project}-valkey"
  description          = "cancel-map pub/sub"
  engine               = "valkey"
  engine_version       = "8.0"
  node_type            = "cache.t4g.micro"
  num_cache_clusters   = 1
  port                 = 6379
  subnet_group_name    = aws_elasticache_subnet_group.valkey.name
  security_group_ids   = [module.data_sg.security_group_id]
  at_rest_encryption_enabled = true
  transit_encryption_enabled = false # in-VPC only; enable + TLS client opts when required
}
