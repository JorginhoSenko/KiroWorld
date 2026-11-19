"""Decode a quantised TopoJSON land file into an exploded GeoJSON FeatureCollection.

Each polygon ring becomes its own feature so the map editor can select,
edit and delete individual landmasses (continents, islands).
"""
import json
import sys
from pathlib import Path


def decode_arc(arc, scale, translate):
    x = y = 0
    out = []
    for dx, dy in arc:
        x += dx
        y += dy
        out.append([x * scale[0] + translate[0], y * scale[1] + translate[1]])
    return out


def ring_from_arcs(arc_indexes, decoded):
    pts = []
    for idx in arc_indexes:
        if idx < 0:
            pts.extend(reversed(decoded[~idx]))
        else:
            pts.extend(decoded[idx])
        pts.pop()  # drop duplicated joint point
    if pts and pts[0] != pts[-1]:
        pts.append(pts[0])
    return pts


def explode(geometry, decoded, out):
    gtype = geometry["type"]
    if gtype == "Polygon":
        rings = [ring_from_arcs(r, decoded) for r in geometry["arcs"]]
        out.append(rings)
    elif gtype == "MultiPolygon":
        for poly in geometry["arcs"]:
            rings = [ring_from_arcs(r, decoded) for r in poly]
            out.append(rings)
    elif gtype == "GeometryCollection":
        for g in geometry.get("geometries", []):
            explode(g, decoded, out)


def main(src, dst):
    topo = json.loads(Path(src).read_text(encoding="utf-8"))
    scale = topo["transform"]["scale"]
    translate = topo["transform"]["translate"]
    decoded = [decode_arc(a, scale, translate) for a in topo["arcs"]]

    polygons = []
    for obj in topo["objects"].values():
        explode(obj, decoded, polygons)

    features = []
    for i, rings in enumerate(polygons):
        features.append({
            "type": "Feature",
            "id": f"base-{i}",
            "properties": {
                "id": f"base-{i}",
                "name": f"陆块 {i + 1}",
                "source": "base",
                "visible": True,
                "locked": False,
            },
            "geometry": {"type": "Polygon", "coordinates": rings},
        })

    fc = {"type": "FeatureCollection", "features": features}
    Path(dst).write_text(json.dumps(fc, ensure_ascii=False), encoding="utf-8")
    total = sum(len(r[0]) for r in polygons)
    print(f"polygons={len(polygons)} exterior_points={total} -> {dst}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
