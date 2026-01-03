import { fetch, ProxyAgent, type Dispatcher, type Response } from "undici";

export class ResyHttpError extends Error {
  readonly url: string;
  readonly status: number;
  readonly bodyText: string;

  constructor(message: string, opts: { url: string; status: number; bodyText: string }) {
    super(message);
    this.name = "ResyHttpError";
    this.url = opts.url;
    this.status = opts.status;
    this.bodyText = opts.bodyText;
  }
}

export type ProxyInput = string;

function proxyToUrl(proxy: ProxyInput): string {
  const trimmed = proxy.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  // Expected legacy format: ip:port:user:pass (username/password may contain ':')
  const parts = trimmed.split(":");
  if (parts.length < 4) {
    throw new Error(
      `Invalid proxy format: "${proxy}". Expected "ip:port:user:pass" or "http(s)://user:pass@ip:port".`,
    );
  }
  const pass = parts.pop()!;
  const user = parts.pop()!;
  const port = parts.pop()!;
  const host = parts.join(":");

  const encUser = encodeURIComponent(user);
  const encPass = encodeURIComponent(pass);
  return `http://${encUser}:${encPass}@${host}:${port}`;
}

async function readResponseBodyText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

async function readJsonOrThrow<T>(url: string, res: Response): Promise<T> {
  const text = await readResponseBodyText(res);
  if (!res.ok) {
    throw new ResyHttpError(`Resy request failed: ${res.status} ${res.statusText}`, {
      url,
      status: res.status,
      bodyText: text,
    });
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(
      `Resy response was not valid JSON (status ${res.status}) for ${url}. Body: ${text.slice(0, 500)}`,
    );
  }
}

export class ResyClient {
  private readonly apiKey: string;
  private readonly agentCache = new Map<string, Dispatcher>();

  constructor(opts?: { apiKey?: string }) {
    this.apiKey = opts?.apiKey ?? process.env.RESY_API_KEY ?? 'VbWk7s3L4KiK5fzlO7JD3Q5EYolJI7n5';
  }

  private dispatcherForProxy(proxy?: ProxyInput): Dispatcher | undefined {
    if (!proxy) return undefined;
    const proxyUrl = proxyToUrl(proxy);
    const existing = this.agentCache.get(proxyUrl);
    if (existing) return existing;
    const agent = new ProxyAgent(proxyUrl);
    this.agentCache.set(proxyUrl, agent);
    return agent;
  }

  private baseHeaders(authToken?: string): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `ResyAPI api_key="${this.apiKey}"`,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
      Accept: "application/json, text/plain, */*",
    };
    if (authToken) {
      headers["X-Resy-Auth-Token"] = authToken;
      headers["X-Resy-Universal-Auth"] = authToken;
      headers.Referer = "https://resy.com/";
      headers.Origin = "https://resy.com";
    }
    return headers;
  }

  async getVenueCalendar(input: {
    restaurantId: string;
    partySize: number;
    startDate: string;
    endDate: string;
    authToken: string;
    proxy?: ProxyInput;
    signal?: AbortSignal;
  }): Promise<any> {
    const url =
      `https://api.resy.com/4/venue/calendar?venue_id=${encodeURIComponent(input.restaurantId)}` +
      `&num_seats=${encodeURIComponent(String(input.partySize))}` +
      `&start_date=${encodeURIComponent(input.startDate)}` +
      `&end_date=${encodeURIComponent(input.endDate)}`;

    const dispatcher = this.dispatcherForProxy(input.proxy);
    const res = await fetch(url, {
      method: "GET",
      headers: this.baseHeaders(input.authToken),
      ...(dispatcher ? { dispatcher } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });

    return await readJsonOrThrow<any>(url, res);
  }

  async findSlots(input: {
    restaurantId: string;
    partySize: number;
    day: string;
    authToken: string;
    proxy?: ProxyInput;
    signal?: AbortSignal;
  }): Promise<any> {
    const url =
      `https://api.resy.com/4/find?lat=0&long=0&day=${encodeURIComponent(input.day)}` +
      `&party_size=${encodeURIComponent(String(input.partySize))}` +
      `&venue_id=${encodeURIComponent(input.restaurantId)}`;

    const dispatcher = this.dispatcherForProxy(input.proxy);
    const res = await fetch(url, {
      method: "GET",
      headers: this.baseHeaders(input.authToken),
      ...(dispatcher ? { dispatcher } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });

    return await readJsonOrThrow<any>(url, res);
  }

  async getBookToken(input: {
    day: string;
    partySize: number;
    configToken: string;
    restaurantId: string;
    authToken: string;
    proxy?: ProxyInput;
    signal?: AbortSignal;
  }): Promise<string> {
    const url =
      `https://api.resy.com/3/details?day=${encodeURIComponent(input.day)}` +
      `&party_size=${encodeURIComponent(String(input.partySize))}` +
      `&x-resy-auth-token=${encodeURIComponent(input.authToken)}` +
      `&venue_id=${encodeURIComponent(input.restaurantId)}` +
      `&config_id=${encodeURIComponent(input.configToken)}`;

    const headers = {
      ...this.baseHeaders(input.authToken),
      "Accept-Encoding": "gzip, deflate, br",
      Host: "api.resy.com",
    };

    const dispatcher = this.dispatcherForProxy(input.proxy);
    const res = await fetch(url, {
      method: "GET",
      headers,
      ...(dispatcher ? { dispatcher } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });

    const data = await readJsonOrThrow<any>(url, res);
    const bookToken = data?.book_token?.value;
    if (!bookToken || typeof bookToken !== "string") {
      throw new Error(`Resy details response did not include book_token.value. Body keys: ${Object.keys(data ?? {})}`);
    }
    return bookToken;
  }

  async bookReservation(input: {
    bookToken: string;
    paymentId: number;
    authToken: string;
    proxy?: ProxyInput;
    signal?: AbortSignal;
  }): Promise<{ status: number; data: any }> {
    const url = "https://api.resy.com/3/book";

    const body = new URLSearchParams();
    body.set("book_token", input.bookToken);
    body.set("struct_payment_method", JSON.stringify({ id: input.paymentId }));
    body.set("source_id", "resy.com-venue-details");

    const headers = {
      ...this.baseHeaders(input.authToken),
      Host: "api.resy.com",
      "X-Origin": "https://widgets.resy.com",
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: "https://widgets.resy.com/",
      "Cache-Control": "no-cache",
      "Sec-Fetch-Dest": "empty",
    };

    const dispatcher = this.dispatcherForProxy(input.proxy);
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      ...(dispatcher ? { dispatcher } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });

    const text = await readResponseBodyText(res);
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    return { status: res.status, data };
  }

  async listUpcomingReservations(input: {
    authToken: string;
    proxy?: ProxyInput;
    signal?: AbortSignal;
  }): Promise<any> {
    const url = "https://api.resy.com/3/user/reservations?type=upcoming";
    const dispatcher = this.dispatcherForProxy(input.proxy);
    const res = await fetch(url, {
      method: "GET",
      headers: this.baseHeaders(input.authToken),
      ...(dispatcher ? { dispatcher } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return await readJsonOrThrow<any>(url, res);
  }

  async cancelReservation(input: {
    authToken: string;
    resyToken: string;
    proxy?: ProxyInput;
    signal?: AbortSignal;
  }): Promise<{ status: number; data: any }> {
    const url = "https://api.resy.com/3/cancel";
    const body = new URLSearchParams();
    body.set("resy_token", input.resyToken);

    const headers = {
      ...this.baseHeaders(input.authToken),
      Host: "api.resy.com",
      "Content-Type": "application/x-www-form-urlencoded",
    };

    const dispatcher = this.dispatcherForProxy(input.proxy);
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      ...(dispatcher ? { dispatcher } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });

    const text = await readResponseBodyText(res);
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    return { status: res.status, data };
  }

  /**
   * Public venue search used by resy.com city browse pages.
   * This returns venue "hits" containing rating + neighborhood + id, etc.
   *
   * Example payload (captured from resy.com):
   * {
   *   availability: true,
   *   page: 1,
   *   per_page: 20,
   *   slot_filter: { day: "2026-01-03", party_size: 2 },
   *   types: ["venue"],
   *   order_by: "availability",
   *   geo: { latitude: 40.7129, longitude: -74.0063, radius: 16100 },
   *   query: ""
   * }
   */
  async venueSearch(input: {
    day: string;
    partySize: number;
    page: number;
    perPage: number;
    latitude: number;
    longitude: number;
    radiusMeters: number;
    query?: string;
    orderBy?: string;
    availability?: boolean;
    proxy?: ProxyInput;
    signal?: AbortSignal;
  }): Promise<any> {
    const url = "https://api.resy.com/3/venuesearch/search";

    const body = {
      availability: input.availability ?? true,
      page: input.page,
      per_page: input.perPage,
      slot_filter: { day: input.day, party_size: input.partySize },
      types: ["venue"],
      order_by: input.orderBy ?? "availability",
      geo: { latitude: input.latitude, longitude: input.longitude, radius: input.radiusMeters },
      query: input.query ?? "",
    };

    const dispatcher = this.dispatcherForProxy(input.proxy);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...this.baseHeaders(),
        "Content-Type": "application/json",
        Origin: "https://resy.com",
        Referer: "https://resy.com/",
      },
      body: JSON.stringify(body),
      ...(dispatcher ? { dispatcher } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });

    return await readJsonOrThrow<any>(url, res);
  }

  /**
   * Venue details page data (includes the \"Need to know\" text block).
   * This is the API call used by resy.com venue pages.
   */
  async getVenueBySlug(input: {
    locationSlug: string; // e.g. "new-york-ny"
    urlSlug: string; // e.g. "4-charles-prime-rib"
    proxy?: ProxyInput;
    signal?: AbortSignal;
  }): Promise<any> {
    const url =
      `https://api.resy.com/3/venue?url_slug=${encodeURIComponent(input.urlSlug)}` +
      `&location=${encodeURIComponent(input.locationSlug)}`;

    const dispatcher = this.dispatcherForProxy(input.proxy);
    const res = await fetch(url, {
      method: "GET",
      headers: {
        ...this.baseHeaders(),
        Origin: "https://resy.com",
        Referer: "https://resy.com/",
      },
      ...(dispatcher ? { dispatcher } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });

    return await readJsonOrThrow<any>(url, res);
  }

  /**
   * Venue config endpoint (contains lead_time_in_days, calendar_date_to, etc).
   */
  async getVenueConfig(input: {
    venueId: number;
    proxy?: ProxyInput;
    signal?: AbortSignal;
  }): Promise<any> {
    const url = `https://api.resy.com/2/config?venue_id=${encodeURIComponent(String(input.venueId))}`;

    const dispatcher = this.dispatcherForProxy(input.proxy);
    const res = await fetch(url, {
      method: "GET",
      headers: {
        ...this.baseHeaders(),
        Origin: "https://resy.com",
        Referer: "https://resy.com/",
      },
      ...(dispatcher ? { dispatcher } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });

    return await readJsonOrThrow<any>(url, res);
  }
}


