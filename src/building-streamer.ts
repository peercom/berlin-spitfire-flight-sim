import {
  Cartesian3,
  Color,
  ConstantProperty,
  CustomDataSource,
  HeightReference,
  PolygonHierarchy,
  Viewer,
} from "cesium";

type OverpassWay = {
  type: "way";
  id: number;
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
};

type OverpassResponse = { elements: OverpassWay[] };

export class BuildingStreamer {
  private readonly source = new CustomDataSource("OpenStreetMap nearby buildings");
  private lastLat = Number.NaN;
  private lastLon = Number.NaN;
  private lastRequest = 0;
  private request?: AbortController;
  private active = false;

  constructor(private readonly viewer: Viewer, private readonly status: (message: string) => void) {
    void viewer.dataSources.add(this.source);
  }

  update(lat: number, lon: number): void {
    const moved = Number.isFinite(this.lastLat) ? distanceMetres(lat, lon, this.lastLat, this.lastLon) : Infinity;
    if (this.active || (moved < 1_600 && performance.now() - this.lastRequest < 28_000)) return;
    void this.load(lat, lon);
  }

  private async load(lat: number, lon: number): Promise<void> {
    this.active = true;
    this.lastRequest = performance.now();
    this.request?.abort();
    this.request = new AbortController();
    this.status("Streaming nearby OpenStreetMap buildings…");
    const query = `[out:json][timeout:18];way["building"](around:1700,${lat.toFixed(6)},${lon.toFixed(6)});out tags geom;`;
    try {
      const response = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`, {
        signal: this.request.signal,
      });
      if (!response.ok) throw new Error(`Overpass ${response.status}`);
      const data = (await response.json()) as OverpassResponse;
      this.source.entities.removeAll();
      let rendered = 0;
      for (const way of data.elements) {
        if (!way.geometry || way.geometry.length < 4 || rendered >= 900) continue;
        const coordinates: number[] = [];
        for (const point of way.geometry) coordinates.push(point.lon, point.lat);
        const tags = way.tags ?? {};
        const height = parseHeight(tags);
        const tone = buildingTone(tags, way.id);
        this.source.entities.add({
          id: `osm-${way.id}`,
          polygon: {
            hierarchy: new PolygonHierarchy(Cartesian3.fromDegreesArray(coordinates)),
            height: 0,
            heightReference: HeightReference.CLAMP_TO_GROUND,
            extrudedHeight: height,
            extrudedHeightReference: HeightReference.RELATIVE_TO_GROUND,
            material: tone,
            outline: false,
            shadows: 1,
          },
          properties: new ConstantProperty(tags),
        });
        rendered += 1;
      }
      this.lastLat = lat;
      this.lastLon = lon;
      this.status(`${rendered.toLocaleString()} nearby buildings · official 20 cm aerial imagery`);
    } catch (error) {
      if ((error as Error).name !== "AbortError") this.status("Building stream delayed · terrain and aerial imagery remain active");
    } finally {
      this.active = false;
    }
  }
}

function parseHeight(tags: Record<string, string>): number {
  const explicit = Number.parseFloat(tags.height ?? "");
  if (Number.isFinite(explicit)) return Math.max(2.5, Math.min(explicit, 260));
  const levels = Number.parseFloat(tags["building:levels"] ?? "");
  if (Number.isFinite(levels)) return Math.max(3, Math.min(levels * 3.15 + 1.2, 180));
  return tags.building === "church" || tags.amenity === "place_of_worship" ? 22 : 10.5;
}

function buildingTone(tags: Record<string, string>, id: number): Color {
  const raw = `${tags["building:colour"] ?? ""} ${tags.material ?? ""}`.toLowerCase();
  if (raw.includes("red") || raw.includes("brick")) return Color.fromCssColorString("#806358").withAlpha(0.98);
  if (raw.includes("white")) return Color.fromCssColorString("#b9b7ac").withAlpha(0.98);
  const palette = ["#8b8172", "#777a78", "#9a8c79", "#6e7475", "#95857a"];
  return Color.fromCssColorString(palette[Math.abs(id) % palette.length]).withAlpha(0.98);
}

function distanceMetres(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const north = (aLat - bLat) * 111_320;
  const east = (aLon - bLon) * 111_320 * Math.cos((aLat * Math.PI) / 180);
  return Math.hypot(north, east);
}
