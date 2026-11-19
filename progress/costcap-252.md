# costcap-252: deploy main to app.costcap.dev (BLOCKED on owner)

Checked 2026-11-19 (persoona-1 lane on dev-home-03):
- https://app.costcap.dev/health still reports sha 85c83a8. /pricing returns 404. origin/main is e6ebb03.
- Deploy run https://github.com/persooninc/costcap/actions/runs/44473752019 (e6ebb03) gets through preflight and the host-key pin, but apply ends with `Permission denied (publickey)`: the host rejects COSTCAP_DEPLOY_SSH_KEY.
- No repo change fixes this. The lane may not touch app-01 or change secrets.

Owner steps (same as the issue comment from 2026-11-18):
1. On app-01, as `ai`, add the public `costcap-deploy` key (SHA256:Lx3kdFlxvlgN0UWGVNb5lchPcVrQdME73qYyrQyMDJM) to `~/.ssh/authorized_keys`.
2. `gh workflow run host-stripe-mode.yml -f mode=live`
3. `gh workflow run deploy.yml`, then check that /health shows the main sha and /pricing returns 200.
