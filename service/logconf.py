"""Centralized logging config.

Call ``setup_logging()`` once at process start. Every other module just does::

    import logging
    log = logging.getLogger(__name__)

and logs through that. Levels: DEBUG (verbose, default for our modules),
INFO (lifecycle events), WARNING (recoverable), ERROR (capture failure etc),
CRITICAL (process should die).
"""
import logging
import os
import sys


_FORMAT = "%(asctime)s.%(msecs)03d %(levelname)-7s %(name)-22s %(message)s"
_DATEFMT = "%H:%M:%S"


def setup_logging(level: str | None = None) -> None:
    """Configure root + uvicorn loggers in one shot.

    Level can be overridden by the ``LOG_LEVEL`` environment variable
    (e.g. ``LOG_LEVEL=DEBUG``). Defaults to DEBUG so the operator sees
    everything during installation runs.
    """
    lvl_name = (level or os.getenv("LOG_LEVEL") or "DEBUG").upper()
    lvl = getattr(logging, lvl_name, logging.DEBUG)

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter(_FORMAT, datefmt=_DATEFMT))

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(lvl)

    # Quiet noisy third-parties unless we explicitly want everything.
    if lvl > logging.DEBUG:
        for noisy in ("uvicorn.access", "watchfiles", "asyncio"):
            logging.getLogger(noisy).setLevel(logging.WARNING)

    logging.getLogger(__name__).info("logging configured at level=%s", lvl_name)
