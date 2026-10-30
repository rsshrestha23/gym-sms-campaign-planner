# Production deployment (platform-neutral)

No cloud provider has been selected, so these are plain Kubernetes manifests (Kustomize) that run
on any conformant cluster (EKS, GKE, AKS, or self-managed). PostgreSQL and Redis are **managed
services**, not in-cluster: the manifests only reference them through secrets.

| File | What |
| --- | --- |
| `kustomization.yaml` | Entry point; set the image tag here (`kubectl apply -k infra/production`). |
| `namespace.yaml` | `gym-sms` namespace with the restricted Pod Security Standard. |
| `config.yaml` | Non-secret configuration (ConfigMap). |
| `external-secrets.yaml` | Pulls secrets from the cloud secret manager via External Secrets Operator. |
| `migrate-job.yaml` | Pre-deploy migration Job (the API itself runs with `RUN_MIGRATIONS=false`). |
| `api.yaml` | API Deployment + Service + HPA + PDB. |
| `dispatcher.yaml` | Due-send dispatcher, outbox relay. |
| `workers.yaml` | BullMQ workers + HPA on queue depth (KEDA) + PDB. |
| `web.yaml` | Static dashboard (nginx). |
| `ingress.yaml` | Public webhook ingress and authenticated dashboard ingress. |
| `network-policies.yaml` | Default-deny plus the allowed flows. |
| `monitoring.yaml` | Prometheus scrape config and alert rules (PrometheusRule). |

## Before the first deploy

1. Provision managed PostgreSQL 16 (PITR on, automated backups, private networking, TLS
   required) and managed Redis 7 with HA, `maxmemory-policy noeviction`, and AOF persistence.
2. Store secrets in the secret manager under the keys listed in `external-secrets.yaml`.
3. Twilio is the selected vendor: fill in the `TWILIO_*` values and the account throughput in `config.yaml`;
   point the Messaging Service status callback at `/v1/webhooks/twilio` (the adapter also sets it per message).
4. Rollout gates in `docs/production-capacity-report.md` must be signed off.

## Deploy order

`kubectl apply -k infra/production` creates everything; Argo CD / Flux sync-waves (annotations
below) make the migration Job finish before the Deployments roll. Migrations are expand-only, so
old and new pods run side by side during the rollout (see `docs/production-runbook.md`).
