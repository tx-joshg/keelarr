# Demo walkthrough

Demo mode runs against a simulated stack. There is no Docker socket behind it,
nothing to break, and no password in the way — so it is the fastest way to see
what Keelarr does before pointing it at anything you care about.

Every screenshot in this repository comes from here, which is also why none of
them contain a real address, path or key.

```bash
npm install && npm run demo
```

Open <http://localhost:4687>.

## 1. The stack

You land on the dashboard with eight apps listed and none of them running —
which is what a stack looks like before anything is deployed.

Press **Deploy 8** in the toolbar — it counts what is not yet deployed, so the
number changes as you go. The rows fill in: health goes green, and the footer
moves to `8 of 8 live · no managed updates pending`.

![The dashboard with eight apps deployed and healthy](images/dashboard.png)

Worth noticing:

- **Image / Version** shows a real release even for `:latest`, because the version
  is read from the image's labels rather than its tag.
- The banner at the top — *"Tautulli is enabled but Plex logs path is empty"* — is
  the same mechanism as the rest of the app. It reports a real gap instead of
  waiting for you to discover it.

## 2. The stack check

Press **Check Wiring**.

![The stack wiring panel](images/stack-check.png)

This is the part worth looking at closely:

- Every connection is listed with **the address it resolved to** and why —
  *"Radarr and SABnzbd share the keelarr network, so SABnzbd resolves by
  container name."*
- **Verified by the app itself: 1 connection test passed.** Keelarr did not decide
  the link works; Radarr did, using its own test endpoint.
- **Needs you** is separated from everything else. Prowlarr has no indexers, so
  nothing in the stack can find releases — and no tool can supply that for you.
  The verdict says the stack is wired *and* that it is not yet working, because
  those are different facts.

## 3. Adoption

Open **Adoption** in the sidebar and press **Scan Docker**.

![The adoption scan](images/adoption.png)

The scan is read-only. It never writes, and it shows env **key names** only,
never values.

Note the last row: `watchtower` is listed as **Unsupported**. Keelarr says when
it does not recognise something rather than adopting it and hoping.

Pick a recognised container and press **Preview Draft** to see the managed
Compose file Keelarr would generate for it — including the mounts, network mode
and volumes it would preserve. Nothing has changed yet; cutover is a separate,
explicit step, and it has a revert.

## 4. Host detection

Open **Settings**.

![Host detection with per-field confidence](images/host-detection.png)

Detection scores every host profile it knows and shows its reasoning. Here the
generic Docker profile scores 95 and QNAP scores 66, and you can click either to
apply its defaults.

Each field carries its own confidence and status. `Plex Logs Path` is `unset`
with `low` confidence — again, stated rather than guessed at.

## 5. Activity

Open **Activity** for the running history: what was deployed, upgraded, wired or
removed, and what each job's steps did.

## What the demo does not show

It is a simulation, so it proves the interface and the reporting, not the
behaviour against Docker. Everything that has been proven against a real host,
and on which host, is in [testing.md](testing.md).

In particular the demo stack is the clean case — one Compose project, one shared
network, every app resolving every other by name. The messier topologies, where
address resolution actually earns its keep, are covered by the unit suite and by
the live QNAP runs.
