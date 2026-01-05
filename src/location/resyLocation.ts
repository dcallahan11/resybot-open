import { ResyClient } from "../resy/resyClient";

export type ResyLocation = {
  name?: string;
  urlSlug: string;
  code?: string;
  timeZone?: string;
  latitude?: number;
  longitude?: number;
  distanceMeters: number;
};

function haversineMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6_371_000; // meters
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export async function resolveNearestResyLocation(input: {
  latitude: number;
  longitude: number;
}): Promise<ResyLocation> {
  const resy = new ResyClient();
  const locations = await resy.getLocationConfig({ latitude: input.latitude, longitude: input.longitude });
  if (!Array.isArray(locations) || locations.length === 0) {
    throw new Error("Resy location config returned no locations");
  }

  let best: ResyLocation | undefined;
  for (const loc of locations) {
    const urlSlug = typeof (loc as any)?.url_slug === "string" ? (loc as any).url_slug : undefined;
    const lat = typeof (loc as any)?.latitude === "number" ? (loc as any).latitude : undefined;
    const lon = typeof (loc as any)?.longitude === "number" ? (loc as any).longitude : undefined;
    if (!urlSlug || lat === undefined || lon === undefined) continue;
    const dist = haversineMeters({ lat: input.latitude, lon: input.longitude }, { lat, lon });
    const next: ResyLocation = {
      urlSlug,
      ...(typeof (loc as any)?.name === "string" ? { name: (loc as any).name } : {}),
      ...(typeof (loc as any)?.code === "string" ? { code: (loc as any).code } : {}),
      ...(typeof (loc as any)?.time_zone === "string" ? { timeZone: (loc as any).time_zone } : {}),
      latitude: lat,
      longitude: lon,
      distanceMeters: dist,
    };
    if (!best || next.distanceMeters < best.distanceMeters) best = next;
  }

  if (!best) throw new Error("Could not resolve a Resy location slug for these coordinates");
  return best;
}


