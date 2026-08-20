# ── ECR: one immutable-tag repo per service (+ kafka-init one-shot) ──────────
resource "aws_ecr_repository" "svc" {
  for_each             = merge(var.services, { "kafka-init" = { port = 0, cpu = 0, memory = 0, public = false } })
  name                 = "${var.project}/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
}

# ── ECS cluster + roles ──────────────────────────────────────────────────────
resource "aws_ecs_cluster" "this" {
  name = "${var.project}-${var.environment}"
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

data "aws_iam_policy_document" "task_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task_execution" {
  name               = "${var.project}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.task_assume.json
}

resource "aws_iam_role_policy_attachment" "task_execution" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Task role: least privilege — SSM read for config; extend per service later.
resource "aws_iam_role" "task" {
  name               = "${var.project}-task"
  assume_role_policy = data.aws_iam_policy_document.task_assume.json
}

resource "aws_cloudwatch_log_group" "svc" {
  for_each          = var.services
  name              = "/ecs/${var.project}/${each.key}"
  retention_in_days = 30
}

locals {
  db_url = "postgres://ollive:${var.db_password}@${module.rds.db_instance_address}:5432/ollive"
  common_env = {
    KAFKA_BROKERS = aws_msk_cluster.this.bootstrap_brokers_sasl_scram
    DATABASE_URL  = local.db_url
    INGEST_URL    = "http://ingest.${var.project}.local:4318" # service discovery / internal ALB — wire in phase 2
    REDIS_URL     = "redis://${aws_elasticache_replication_group.valkey.primary_endpoint_address}:6379"
    CORS_ORIGIN   = "https://app.example.com" # set to the real dashboard origin
  }
}

resource "aws_ecs_task_definition" "svc" {
  for_each                 = var.services
  family                   = "${var.project}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }
  execution_role_arn = aws_iam_role.task_execution.arn
  task_role_arn      = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = each.key
      image     = "${aws_ecr_repository.svc[each.key].repository_url}:${var.image_tag}"
      essential = true
      portMappings = each.value.port > 0 ? [{ containerPort = each.value.port, protocol = "tcp" }] : []
      environment = [for k, v in local.common_env : { name = k, value = v }]
      secrets = var.anthropic_api_key_arn != "" && each.key == "api" ? [
        { name = "ANTHROPIC_API_KEY", valueFrom = var.anthropic_api_key_arn }
      ] : []
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.svc[each.key].name
          awslogs-region        = var.region
          awslogs-stream-prefix = each.key
        }
      }
    }
  ])
}

resource "aws_ecs_service" "svc" {
  for_each        = var.services
  name            = each.key
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.svc[each.key].arn
  desired_count   = each.key == "worker" ? 1 : 2
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = module.vpc.private_subnets
    security_groups = [module.app_sg.security_group_id]
  }

  dynamic "load_balancer" {
    for_each = each.value.public ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.svc[each.key].arn
      container_name   = each.key
      container_port   = each.value.port
    }
  }
}
