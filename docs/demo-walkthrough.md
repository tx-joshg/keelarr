# Keelarr Demo Walkthrough

## Launch

```bash
cd keelarr
npm install
npm run demo
```

Open `http://localhost:4687`.

## Review Path

1. Confirm the `Interactive Demo` banner is visible near the top of the dashboard.
2. Review the prefilled QNAP-style host settings in `One-Time Host Config`.
3. Click `Scan Existing Docker` and verify the adoption section shows:
   - `trailarr` as adoptable
   - `ombi` as recognized with an image-tag note
   - `tautulli` as recognized but blocked by a missing `/plex_logs` mount
4. Click `Preview Adoption` on `trailarr`.
5. Review the `Preview Managed Draft` section and confirm it shows:
   - preserved `/config` and `/Media` mounts
   - target stack folder under `/share/Container/docker/trailarr`
   - safe next steps before cutover
6. Click `Generate Managed Draft`.
7. Confirm the adoption scan now shows `trailarr` as `Drafted`.
8. Use `Open` on any managed app card and confirm the stub app page loads.
9. Click `Upgrade All` or a per-service `Upgrade` button and verify recent activity updates.
10. Click `Reset Demo` to restore the original seeded scenario.

## What The Demo Proves

- the dashboard is interactive
- host detection is surfaced in the UI
- managed service actions update live state
- import scan and adoption preview are wired end to end
- safe draft adoption works without touching a real Docker host
