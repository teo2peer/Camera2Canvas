"""Dominant-colour extraction.

KMeans-clusters the visible (alpha > 32) pixels of a captured drawing
into ``k`` clusters and returns the centroids as ``#rrggbb`` hex strings,
sorted by cluster population (most-used colour first).
"""
import logging
import numpy as np
from sklearn.cluster import KMeans

log = logging.getLogger("service.palette")


def extract_palette(rgba: np.ndarray, k: int = 5) -> list[str]:
    """Return ``k`` hex colours sorted by frequency.

    ``rgba`` must be HxWx{3,4} uint8.
    """
    if rgba.shape[2] == 4:
        mask = rgba[..., 3] > 32
        pixels = rgba[mask][:, :3]
    else:
        pixels = rgba.reshape(-1, 3)
    if len(pixels) < k:
        log.debug("palette: too few visible pixels (%d < %d), returning grey", len(pixels), k)
        return ["#888888"] * k
    sample = pixels[np.random.choice(len(pixels), size=min(8000, len(pixels)), replace=False)]
    km = KMeans(n_clusters=k, n_init=4, random_state=0).fit(sample)
    centers = km.cluster_centers_.astype(int)
    counts = np.bincount(km.labels_, minlength=k)
    order = np.argsort(-counts)
    return ["#{:02x}{:02x}{:02x}".format(*centers[i]) for i in order]
