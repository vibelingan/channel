# Alibaba account setup — steps for the client

Send this to whoever owns the Alibaba.com seller account. It is written to be
readable without any knowledge of our system.

## What we are asking for and why

We are connecting your Alibaba.com supplier account to your online store so
that product prices and stock on the store stay in step with what your
supplier actually offers, instead of being typed in by hand and going stale.

Two things are needed from you:

1. A one-time setting added to the Alibaba app (about two minutes).
2. One click to approve the connection, from your own store's admin page.

We never ask for and never receive your Alibaba password. The approval happens
on Alibaba's own site, and Alibaba hands our server a revocable access key
afterwards. You can withdraw it from your Alibaba console at any time.

---

## Part 1 — add the callback address (do this first)

A "callback address" is where Alibaba sends your browser back to after you
approve. Alibaba only allows addresses that are on the app's approved list, so
this has to be added before the approval will work.

**The address to add, exactly as written:**

```
https://supplychainsai.com/api/alibaba-catalog-sync/oauth/callback
```

Copy and paste it rather than typing it. It must match exactly — no trailing
slash, no `www.`, and it must start with `https`.

**Steps:**

1. Go to **open.alibaba.com** and sign in with the account that owns the app.
2. Open the console and find your applications — this is usually
   **Console → My Apps** (控制台 → 我的应用).
3. Open the app with **App Key `511630`**.
4. Find the callback address setting. Depending on which version of the console
   you see, it is in one of these places:
   - **Authorization Management** (授权管理)
   - **App Information → Callback Address** (应用信息 → 回调地址)
   - **OAuth Configuration** (OAuth 配置)
   - a **Basic Information** or **App Details** page with a field labelled
     *Redirect URI* or *回调 URL*
5. Paste the address into that field.
   - If the app already has other callback addresses listed, **add** this one
     rather than replacing them.
   - If the console lets you save more than one, also add this second address
     as a backup — it reaches the same place by a different route:
     ```
     https://diversity-123-d9grnqfux221323bb.service.tcloudbase.com/api/alibaba-catalog-sync/oauth/callback
     ```
6. Save.

Changes sometimes take a few minutes to take effect. If step 2 below fails
immediately after saving, wait five minutes and try once more before treating
it as a problem.

---

## Part 2 — approve the connection

Do this only after Part 1 is saved, and after we confirm the store update is
live. We will tell you when.

1. Sign in to the store's admin dashboard.
2. Open **Alibaba Sync** in the left-hand menu.
3. Click **Connect**.
4. You will be taken to Alibaba. Sign in if asked, and approve the request.
5. Alibaba returns you to the admin page, which will show either a confirmation
   that the account is connected, or a specific message explaining what went
   wrong.

If it fails, the message on that page tells us exactly which step failed —
please send us a screenshot of it rather than only saying it did not work.

---

## Part 3 — the first sync

1. On the same page, click **Run now**.
2. A row appears in the run table showing what happened: how many products were
   read, how many had problems, and a short summary if it stopped early.

**Nothing on your public store changes yet.** Supplier products are brought in
and held for review first. A product on your store only starts showing supplier
pricing once someone deliberately links it. Nothing is published automatically.

At this stage, sync runs **only when someone clicks "Run now"**. Automatic
scheduled updates are a deliberate second step, switched on once the first
manual runs have gone cleanly.

---

## What you may be asked and what is true

**Does this give access to my Alibaba account?**
It gives read access to your product listings through Alibaba's official
integration. Revocable by you at any time in the Alibaba console.

**Will my store prices change immediately?**
No. Products are brought in for review. Supplier pricing appears on a product
only after someone links that product on purpose.

**Do I need to keep a password anywhere?**
No. There is no password in this process. Alibaba issues a key directly to the
server after you approve, and it is stored encrypted.

**Who do I contact if something looks wrong?**
Send a screenshot of the admin page — the run table and any message shown. It
records what happened on each run, which is usually enough to diagnose.
