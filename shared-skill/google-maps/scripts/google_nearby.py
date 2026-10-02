#!/usr/bin/env python3
"""Recommend nearby places using Google Places and Routes APIs.

Reads GOOGLE_MAPS_API_KEY from the process environment only.
The key is never printed or written into output.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

PLACES_URL = "https://places.googleapis.com/v1/places:searchNearby"
ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes"
FIELD_MASK = ",".join(
    [
        "places.id",
        "places.displayName",
        "places.formattedAddress",
        "places.location",
        "places.rating",
        "places.userRatingCount",
        "places.googleMapsUri",
        "places.websiteUri",
        "places.priceLevel",
        "places.primaryType",
        "places.businessStatus",
        "places.currentOpeningHours",
        "places.regularOpeningHours",
        "places.utcOffsetMinutes",
    ]
)


def load_key() -> str:
    key = os.getenv("GOOGLE_MAPS_API_KEY", "").strip()
    if key:
        return key
    raise SystemExit("GOOGLE_MAPS_API_KEY is missing. Configure it in this agent instance env file.")


def post_json(url: str, payload: dict[str, Any], key: str, field_mask: str) -> Any:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Goog-Api-Key": key,
            "X-Goog-FieldMask": field_mask,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Google API returned HTTP {exc.code}; check API access and request parameters") from None
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Google API request failed: {exc.reason}") from None


def quality_score(place: dict[str, Any]) -> float:
    """Weight rating by review volume without letting chains dominate completely."""
    rating = float(place.get("rating", 0.0))
    reviews = max(int(place.get("userRatingCount", 0)), 0)
    if not rating:
        return 0.0
    confidence = 1.0 - math.exp(-reviews / 250.0)
    return round(rating * (0.65 + 0.35 * confidence), 4)


def hours_summary(place: dict[str, Any]) -> dict[str, Any]:
    hours = place.get("currentOpeningHours") or place.get("regularOpeningHours") or {}
    offset_minutes = int(place.get("utcOffsetMinutes", 0))
    local_now = dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=offset_minutes)
    result: dict[str, Any] = {
        "open_now": hours.get("openNow"),
        "local_time": local_now.strftime("%Y-%m-%d %H:%M"),
        "today": None,
        "next_open_time": hours.get("nextOpenTime"),
        "next_close_time": hours.get("nextCloseTime"),
    }
    descriptions = hours.get("weekdayDescriptions") or []
    if len(descriptions) >= 7:
        result["today"] = descriptions[local_now.weekday()]
    return result


def route(
    key: str,
    origin: tuple[float, float],
    destination: tuple[float, float],
    mode: str,
) -> dict[str, Any]:
    payload = {
        "origin": {
            "location": {
                "latLng": {"latitude": origin[0], "longitude": origin[1]}
            }
        },
        "destination": {
            "location": {
                "latLng": {
                    "latitude": destination[0],
                    "longitude": destination[1],
                }
            }
        },
        "travelMode": mode,
    }
    if mode == "DRIVE":
        payload["routingPreference"] = "TRAFFIC_AWARE"
    data = post_json(
        ROUTES_URL, payload, key, "routes.duration,routes.distanceMeters"
    )
    routes = data.get("routes") or []
    if not routes:
        return {"distance_m": None, "duration_seconds": None, "duration_minutes": None}
    first = routes[0]
    duration_raw = str(first.get("duration", "0s"))
    try:
        seconds = int(round(float(duration_raw.removesuffix("s"))))
    except ValueError:
        seconds = None
    return {
        "distance_m": first.get("distanceMeters"),
        "duration_seconds": seconds,
        "duration_minutes": math.ceil(seconds / 60) if seconds is not None else None,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Recommend highly rated nearby places and estimate travel time."
    )
    parser.add_argument("latitude", type=float)
    parser.add_argument("longitude", type=float)
    parser.add_argument("place_type", help="Google place type, e.g. cafe or restaurant")
    parser.add_argument("--radius", type=float, default=1500.0)
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument(
        "--mode", choices=["WALK", "DRIVE", "BICYCLE", "TRANSIT"], default="WALK"
    )
    parser.add_argument("--open-now", action="store_true")
    parser.add_argument("--min-rating", type=float, default=0.0)
    parser.add_argument("--min-reviews", type=int, default=0)
    parser.add_argument("--language", default="en")
    parser.add_argument("--region", default="")
    args = parser.parse_args()

    if not (-90 <= args.latitude <= 90 and -180 <= args.longitude <= 180):
        parser.error("invalid latitude or longitude")
    if not (1 <= args.limit <= 10):
        parser.error("--limit must be between 1 and 10")
    if not (1 <= args.radius <= 50000):
        parser.error("--radius must be between 1 and 50000 meters")

    key = load_key()
    origin = (args.latitude, args.longitude)
    payload: dict[str, Any] = {
        "includedTypes": [args.place_type],
        "maxResultCount": 20,
        "rankPreference": "POPULARITY",
        "languageCode": args.language,
        "locationRestriction": {
            "circle": {
                "center": {
                    "latitude": args.latitude,
                    "longitude": args.longitude,
                },
                "radius": args.radius,
            }
        },
    }
    if args.region:
        payload["regionCode"] = args.region

    data = post_json(PLACES_URL, payload, key, FIELD_MASK)
    candidates = []
    for place in data.get("places", []):
        rating = float(place.get("rating", 0.0))
        reviews = int(place.get("userRatingCount", 0))
        hours = hours_summary(place)
        if rating < args.min_rating or reviews < args.min_reviews:
            continue
        if args.open_now and hours.get("open_now") is not True:
            continue
        place["_hours"] = hours
        place["_score"] = quality_score(place)
        candidates.append(place)

    candidates.sort(
        key=lambda p: (
            p.get("_hours", {}).get("open_now") is True,
            p.get("_score", 0.0),
            p.get("userRatingCount", 0),
        ),
        reverse=True,
    )

    results = []
    for place in candidates[: args.limit]:
        location = place.get("location") or {}
        destination = (location.get("latitude"), location.get("longitude"))
        route_data = {
            "distance_m": None,
            "duration_seconds": None,
            "duration_minutes": None,
        }
        if all(value is not None for value in destination):
            route_data = route(key, origin, destination, args.mode)
        directions_mode = {
            "WALK": "walking",
            "DRIVE": "driving",
            "BICYCLE": "bicycling",
            "TRANSIT": "transit",
        }[args.mode]
        directions_params = urllib.parse.urlencode(
            {
                "api": 1,
                "origin": f"{origin[0]},{origin[1]}",
                "destination": f"{destination[0]},{destination[1]}",
                "travelmode": directions_mode,
            }
        )
        results.append(
            {
                "name": (place.get("displayName") or {}).get("text"),
                "type": place.get("primaryType"),
                "address": place.get("formattedAddress"),
                "rating": place.get("rating"),
                "review_count": place.get("userRatingCount"),
                "quality_score": place.get("_score"),
                "hours": place.get("_hours"),
                "price_level": place.get("priceLevel"),
                "business_status": place.get("businessStatus"),
                "travel_mode": args.mode.lower(),
                **route_data,
                "google_maps_url": place.get("googleMapsUri"),
                "directions_url": "https://www.google.com/maps/dir/?" + directions_params,
                "website": place.get("websiteUri"),
                "place_id": place.get("id"),
                "location": location,
            }
        )

    output = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "origin": {"latitude": origin[0], "longitude": origin[1]},
        "search": {
            "place_type": args.place_type,
            "radius_m": args.radius,
            "open_now_only": args.open_now,
            "min_rating": args.min_rating,
            "min_reviews": args.min_reviews,
        },
        "ranking": "Rating weighted by review-volume confidence; open places rank first.",
        "results": results,
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
