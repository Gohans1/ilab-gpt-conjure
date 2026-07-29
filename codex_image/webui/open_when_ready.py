from __future__ import annotations

import argparse
import time
from urllib.error import URLError
from urllib.request import urlopen
import webbrowser


def wait_and_open(
    health_url: str,
    url: str,
    *,
    attempts: int,
    interval: float,
) -> bool:
    for _ in range(max(1, attempts)):
        try:
            with urlopen(health_url, timeout=0.5) as response:
                if response.status == 200:
                    webbrowser.open(url)
                    return True
        except (OSError, URLError):
            pass
        time.sleep(max(0.05, interval))
    return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--health-url", required=True)
    parser.add_argument("--url", required=True)
    parser.add_argument("--attempts", type=int, default=60)
    parser.add_argument("--interval", type=float, default=0.5)
    args = parser.parse_args()
    return (
        0
        if wait_and_open(
            args.health_url,
            args.url,
            attempts=args.attempts,
            interval=args.interval,
        )
        else 1
    )


if __name__ == "__main__":
    raise SystemExit(main())
