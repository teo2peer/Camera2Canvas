from pathlib import Path
import json
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DRAW_DIR = DATA_DIR / "drawings"
THUMB_DIR = DATA_DIR / "thumbs"
DB_PATH = DATA_DIR / "drawings.db"
SETTINGS_PATH = DATA_DIR / "settings.json"

for p in (DATA_DIR, DRAW_DIR, THUMB_DIR):
    p.mkdir(parents=True, exist_ok=True)


class Settings(BaseModel):
    scan_trigger: str = "auto+gesture"  # auto | gesture | auto+gesture
    camera_mode: str = "overhead"        # overhead | front | both
    overhead_camera_index: int = 0
    front_camera_index: int = 1
    mirror_overhead: bool = False
    mirror_front: bool = True       # most user-facing webcams stream a mirror image
    bg_removal: str = "threshold"        # threshold | ml
    led_count: int = 300
    led_serial_port: str = ""
    led_baud: int = 921600
    gesture_sensitivity: float = 0.7
    paper_min_area_ratio: float = 0.05
    paper_inset: float = 0.06             # crop applied after warp (removes corner markers)
    stability_frames: int = 8

    # threshold_remove tuning (live-tunable from /playground/)
    bg_block_size: int = 41
    bg_C: int = 12
    bg_speckle: int = 8
    bg_feather: int = 1

    # grid sheet: cells per long / short edge of the printed sheet (landscape)
    grid_cols: int = 50
    grid_rows: int = 30

    ws_host: str = "0.0.0.0"
    http_port: int = 8765


def load_settings() -> Settings:
    if SETTINGS_PATH.exists():
        try:
            return Settings(**json.loads(SETTINGS_PATH.read_text("utf-8")))
        except Exception:
            pass
    s = Settings()
    save_settings(s)
    return s


def save_settings(s: Settings) -> None:
    SETTINGS_PATH.write_text(json.dumps(s.model_dump(), indent=2), "utf-8")
