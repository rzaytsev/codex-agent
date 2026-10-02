---
name: google-maps
description: Find nearby places, compare ratings and opening hours, estimate travel times, and share Google Maps links. Also geocode addresses and search open map data when Google access is unavailable.
---

# Google Maps

Scripts are beside this file in `scripts/`. In the Docker agents this skill is mounted read-only at `/workspace/.agents/skills/google-maps`. Python 3 is available; both helpers use only its standard library. Save search results in the agent's private workspace. Keep shared source unchanged. Put personal modifications in an instance-local skill or an explicitly configured private shared copy; validate them before use.

## Google places and travel times

Use `scripts/google_nearby.py` for Google ratings, review counts, opening hours and real route estimates. It reads `GOOGLE_MAPS_API_KEY` from the environment; never print the key or read instance env/auth files. The key needs Google Places API (New) and Routes API enabled. Requests use the Google account's API billing, separately from Codex subscription usage. Each invocation performs one places request and up to `--limit` route requests; keep limits proportional to the user's request.

```sh
python3 /workspace/.agents/skills/google-maps/scripts/google_nearby.py 40.4168 -3.7038 cafe --radius 1500 --limit 5 --mode WALK --open-now --language es
```

Arguments: latitude, longitude, Google place type; optional `--radius` (meters, up to 50000), `--limit` (1–10), `--mode` (`WALK`, `DRIVE`, `BICYCLE`, `TRANSIT`), `--open-now`, `--min-rating`, `--min-reviews`, `--language`, `--region`.

An explicit place in the current request takes precedence. Otherwise use assistant MCP `location_get`: it selects the user's temporary Telegram location for 12 hours, then the default location. Mention when using the default; if neither exists, ask. Never use older Telegram pins from history/inbox as a current-location fallback. Use `location_set_default` only when explicitly asked to change the usual location. Geocode ambiguous addresses with the open-data helper and disambiguate before searching. The current ranking favors open venues, then a rating score weighted by review count; it is not a shortest-route ranking. Keep hours and availability qualified by retrieval time. Do not claim bookings, live transit departures or guaranteed accessibility from these results.

Present concise options with rating/review count, hours when known, travel estimate with mode, and clickable Maps/directions links from the returned JSON. Distinguish road travel estimates from straight-line distances.

## Open-data helper

If Google access is unavailable, report that limitation and use `scripts/maps_client.py` for OpenStreetMap/Nominatim geocoding and Overpass POIs. These are open-data results with Google Maps links, not Google Places ratings or reviews.

```sh
python3 /workspace/.agents/skills/google-maps/scripts/maps_client.py search "Puerta del Sol, Madrid, Spain"
python3 /workspace/.agents/skills/google-maps/scripts/maps_client.py reverse 40.4168 -3.7038
python3 /workspace/.agents/skills/google-maps/scripts/maps_client.py nearby --near "Madrid, Spain" --category cafe --radius 1000 --limit 5
python3 /workspace/.agents/skills/google-maps/scripts/maps_client.py distance "Madrid" --to "Toledo" --mode driving
python3 /workspace/.agents/skills/google-maps/scripts/maps_client.py area "Madrid, Spain"
```

Run `--help` or `<command> --help` for categories, bounding-box search, directions and timezone commands. Public services can reject or rate-limit requests; avoid bulk queries and parallel geocoding. The helper's sleep is per invocation, not a cross-agent rate limiter. OSRM public-server walking/cycling profiles are not independently verified; use Google for mode-specific estimates. Timezone fallback can be a longitude-based approximation; preserve that qualification. Community opening hours may be stale; verify current hours before making an open-now recommendation.
