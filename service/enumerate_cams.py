"""List available cameras. Tries DirectShow names on Windows, then numeric probe."""
import cv2


def list_named() -> list[dict]:
    try:
        from pygrabber.dshow_graph import FilterGraph
        names = FilterGraph().get_input_devices()
        return [{"index": i, "name": n} for i, n in enumerate(names)]
    except Exception:
        return []


def probe_numeric(max_index: int = 8) -> list[dict]:
    out = []
    for i in range(max_index):
        cap = None
        try:
            cap = cv2.VideoCapture(i, cv2.CAP_DSHOW)
            if cap.isOpened():
                ok, _ = cap.read()
                if ok:
                    out.append({"index": i, "name": f"Camera {i}"})
        except Exception:
            pass
        finally:
            if cap is not None:
                cap.release()
    return out


def list_all() -> list[dict]:
    named = list_named()
    if named:
        return named
    return probe_numeric()
