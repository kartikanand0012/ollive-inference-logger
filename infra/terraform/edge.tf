# ── ALB: path routing — /v1/logs → ingest, /v1/* → api, default → web ────────
resource "aws_lb" "this" {
  name               = "${var.project}-${var.environment}"
  load_balancer_type = "application"
  security_groups    = [module.alb_sg.security_group_id]
  subnets            = module.vpc.public_subnets
}

resource "aws_lb_target_group" "svc" {
  for_each    = { for k, v in var.services : k => v if v.public }
  name        = "${var.project}-${each.key}"
  port        = each.value.port
  protocol    = "HTTP"
  vpc_id      = module.vpc.vpc_id
  target_type = "ip"

  health_check {
    path                = each.key == "web" ? "/" : "/readyz"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

# HTTP only until an ACM cert + domain exist; then add the :443 listener with
# certificate_arn and make :80 a redirect.
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.svc["web"].arn
  }
}

resource "aws_lb_listener_rule" "ingest" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 10
  condition {
    path_pattern { values = ["/v1/logs*"] }
  }
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.svc["ingest"].arn
  }
}

resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 20
  condition {
    path_pattern { values = ["/v1/*", "/healthz", "/readyz"] }
  }
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.svc["api"].arn
  }
}

# ── WAF: managed rules + rate-based rule, in front of everything ─────────────
resource "aws_wafv2_web_acl" "this" {
  name  = "${var.project}-${var.environment}"
  scope = "REGIONAL"
  default_action {
    allow {}
  }

  rule {
    name     = "aws-common"
    priority = 1
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "aws-common"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "rate-per-ip"
    priority = 2
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = 2000 # per 5 min per IP — volumetric floods die here
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "rate-per-ip"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.project}-acl"
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "alb" {
  resource_arn = aws_lb.this.arn
  web_acl_arn  = aws_wafv2_web_acl.this.arn
}
