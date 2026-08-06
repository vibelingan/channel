# Setup — one-time, before the first Connect

Everything here is done once, by a human, before anyone opens the admin page.
Nothing in the feature works until all of it is done.

## The values you already have

| Thing | Value | Where it came from |
|---|---|---|
| Tencent CloudBase env id | `diversity-123-d9grnqfux221323bb` | GitHub → repo → Settings → Environments → `test` → Variables → `TCB_ENV_ID` |
| Region | `ap-shanghai` | same place, `CLOUDBASE_REGION` |
| Callback URL | `https://diversity-123-d9grnqfux221323bb.service.tcloudbase.com/api/alibaba-catalog-sync/oauth/callback` | built from the env id — see below |
| Alibaba app key | `511630` | Alibaba Open Platform console, your app |

The callback URL is just `https://<env-id>.service.tcloudbase.com` +
`/api/alibaba-catalog-sync/oauth/callback`. Same host the public catalog API
already uses, so no new domain or certificate is involved.

## Step 1 — five secrets in the GitHub `test` environment

Run these yourself. They are written so no secret value is ever typed on
screen, echoed, or left in shell history.

```bash
gh secret set ALI_APP_KEY --env test --body '511630'
```

```bash
gh secret set ALI_OAUTH_CALLBACK_URL --env test --body 'https://diversity-123-d9grnqfux221323bb.service.tcloudbase.com/api/alibaba-catalog-sync/oauth/callback'
```

```bash
read -rs -p "Alibaba app secret: " V && printf '%s' "$V" | gh secret set ALI_APP_SECRET --env test && unset V && echo " set"
```

```bash
openssl rand -hex 32 | tr -d '\n' | gh secret set ALI_TOKEN_ENCRYPTION_KEY_V1 --env test && echo "generated + set"
```

```bash
read -rs -p "WeCom webhook URL: " V && printf '%s' "$V" | gh secret set WECOM_WEBHOOK_URL --env test && unset V && echo " set"
```

Check the names landed (values are never displayed):

```bash
gh secret list --env test
```

### What `ALI_TOKEN_ENCRYPTION_KEY_V1` is

It is **not** something Alibaba gives you. You generate it.

When you connect, Alibaba hands the server an access token and a refresh
token — credentials that can read your supplier account. Rather than store
those as-is, the function encrypts them with this key first. If someone ever
got a copy of the database, they would hold ciphertext instead of working
supplier credentials.

The command above generates 32 random bytes as 64 hex characters and pipes
them straight into GitHub, so the key never appears on your screen and never
enters shell history. You do not need a copy of it. If it is ever lost,
Connect again — a new token gets encrypted under the new key. If it is ever
rotated, existing stored tokens stop decrypting and the connection reports
`decrypt-failed`, which is the expected, safe behaviour.

The `_V1` suffix exists so a second key can be introduced later without a
flag day.

### If you skip the WeCom webhook

Nothing breaks, but alerts become log lines nobody reads. Worth setting before
the first real run.

## Step 2 — register the callback URL with Alibaba

Alibaba refuses to redirect a browser to any address not on the app's list, so
the Connect button fails at the last hop until this is done.

In the Alibaba Open Platform console (open.alibaba.com), open **your app
(key `511630`)** and find its callback / redirect URL setting — the console
labels this differently across sections; look for "Callback URL", "Redirect
URI", or "回调地址" in the app's authorization or basic-information page.

Add exactly:

```
https://diversity-123-d9grnqfux221323bb.service.tcloudbase.com/api/alibaba-catalog-sync/oauth/callback
```

It must match character for character — no trailing slash, `https`, no
`www`. Some consoles accept several entries; if so, keep the test one and add
production later rather than replacing it.

> I have not been able to verify the current console's exact menu path. The
> requirement (an exact-match HTTPS callback on the app's allowlist) is
> certain; the navigation wording may differ from the above.

## Step 3 — deploy

Push the branch to `test`. That single deploy creates the ten database tables
and their indexes, uploads the function, sets its environment variables, and
wires `/api/alibaba-catalog-sync`. No servers to provision.

## Step 4 — connect, then run

1. Open the admin dashboard → **Alibaba Sync**.
2. Click **Connect**. You go to Alibaba, log in, approve, and land back on the
   admin page with a banner saying connected — or a specific reason it failed.
3. Click **Run now**. The test environment has no timer by design, so this
   button is the only thing that drives a sync there.
4. Read the run table: status, items processed, parse failures, and a one-line
   error summary per run.

## Sanity check before you start

```bash
curl -s https://diversity-123-d9grnqfux221323bb.service.tcloudbase.com/api/alibaba-catalog-sync/health
```

Returns release info when the function is deployed and booting cleanly. This
answers "is it even there" before you touch the admin page.
