/** Meta Graph API helpers for demo publishing (single image). */

const GRAPH_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

type GraphErrorBody = { error?: { message?: string } };

async function graphJson<T>(url: string, init?: RequestInit): Promise<T & GraphErrorBody> {
  const res = await fetch(url, init);
  return res.json() as Promise<T & GraphErrorBody>;
}

export async function publishFacebookPagePhoto(input: {
  pageId: string;
  pageAccessToken: string;
  imageUrl: string;
  caption: string;
}): Promise<{ id: string; permalink?: string }> {
  const u = new URL(`${GRAPH_BASE}/${input.pageId}/photos`);
  u.searchParams.set("url", input.imageUrl);
  u.searchParams.set("access_token", input.pageAccessToken);
  if (input.caption) u.searchParams.set("message", input.caption);

  const json = await graphJson<{ id?: string }>(u.toString(), { method: "POST" });
  if (json.error?.message) throw new Error(json.error.message);
  const id = json.id;
  if (!id) throw new Error("Facebook did not return a photo id.");

  let permalink: string | undefined;
  try {
    const pu = new URL(`${GRAPH_BASE}/${id}`);
    pu.searchParams.set("fields", "permalink_url");
    pu.searchParams.set("access_token", input.pageAccessToken);
    const pj = await graphJson<{ permalink_url?: string }>(pu.toString());
    permalink = pj.permalink_url;
  } catch {
    /* permalink is optional for demo */
  }

  return { id, permalink };
}

async function waitForInstagramContainer(
  containerId: string,
  pageAccessToken: string,
): Promise<void> {
  for (let attempt = 0; attempt < 45; attempt++) {
    const u = new URL(`${GRAPH_BASE}/${containerId}`);
    u.searchParams.set("fields", "status_code");
    u.searchParams.set("access_token", pageAccessToken);
    const json = await graphJson<{ status_code?: string }>(u.toString());
    if (json.error?.message) throw new Error(json.error.message);
    const code = json.status_code;
    if (code === "FINISHED") return;
    if (code === "ERROR" || code === "EXPIRED") {
      throw new Error(`Instagram container failed (${code ?? "unknown"}).`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Instagram media is still processing — try again in a moment.");
}

export async function publishInstagramFeedImage(input: {
  igUserId: string;
  pageAccessToken: string;
  imageUrl: string;
  caption: string;
}): Promise<{ id: string; permalink?: string }> {
  const create = new URL(`${GRAPH_BASE}/${input.igUserId}/media`);
  create.searchParams.set("image_url", input.imageUrl);
  create.searchParams.set("access_token", input.pageAccessToken);
  if (input.caption) create.searchParams.set("caption", input.caption);

  const created = await graphJson<{ id?: string }>(create.toString(), { method: "POST" });
  if (created.error?.message) throw new Error(created.error.message);
  const creationId = created.id;
  if (!creationId) throw new Error("Instagram did not return a creation id.");

  await waitForInstagramContainer(creationId, input.pageAccessToken);

  const pub = new URL(`${GRAPH_BASE}/${input.igUserId}/media_publish`);
  pub.searchParams.set("creation_id", creationId);
  pub.searchParams.set("access_token", input.pageAccessToken);
  const published = await graphJson<{ id?: string }>(pub.toString(), { method: "POST" });
  if (published.error?.message) throw new Error(published.error.message);
  const mediaId = published.id;
  if (!mediaId) throw new Error("Instagram did not return a media id.");

  let permalink: string | undefined;
  try {
    const pu = new URL(`${GRAPH_BASE}/${mediaId}`);
    pu.searchParams.set("fields", "permalink");
    pu.searchParams.set("access_token", input.pageAccessToken);
    const pj = await graphJson<{ permalink?: string }>(pu.toString());
    permalink = pj.permalink;
  } catch {
    /* optional */
  }

  return { id: mediaId, permalink };
}

export async function publishInstagramCarousel(input: {
  igUserId: string;
  pageAccessToken: string;
  imageUrls: string[];
  caption: string;
}): Promise<{ id: string; permalink?: string }> {
  const urls = input.imageUrls;
  if (urls.length < 2) {
    throw new Error("Instagram carousel requires at least two images.");
  }

  const childIds: string[] = [];
  for (const imageUrl of urls) {
    const create = new URL(`${GRAPH_BASE}/${input.igUserId}/media`);
    create.searchParams.set("image_url", imageUrl);
    create.searchParams.set("is_carousel_item", "true");
    create.searchParams.set("access_token", input.pageAccessToken);

    const created = await graphJson<{ id?: string }>(create.toString(), { method: "POST" });
    if (created.error?.message) throw new Error(created.error.message);
    const creationId = created.id;
    if (!creationId) throw new Error("Instagram did not return a carousel item id.");

    await waitForInstagramContainer(creationId, input.pageAccessToken);
    childIds.push(creationId);
  }

  const carousel = new URL(`${GRAPH_BASE}/${input.igUserId}/media`);
  carousel.searchParams.set("media_type", "CAROUSEL");
  carousel.searchParams.set("children", childIds.join(","));
  carousel.searchParams.set("access_token", input.pageAccessToken);
  if (input.caption) carousel.searchParams.set("caption", input.caption);

  const carJson = await graphJson<{ id?: string }>(carousel.toString(), { method: "POST" });
  if (carJson.error?.message) throw new Error(carJson.error.message);
  const carouselId = carJson.id;
  if (!carouselId) throw new Error("Instagram did not return a carousel id.");

  await waitForInstagramContainer(carouselId, input.pageAccessToken);

  const pub = new URL(`${GRAPH_BASE}/${input.igUserId}/media_publish`);
  pub.searchParams.set("creation_id", carouselId);
  pub.searchParams.set("access_token", input.pageAccessToken);
  const published = await graphJson<{ id?: string }>(pub.toString(), { method: "POST" });
  if (published.error?.message) throw new Error(published.error.message);
  const mediaId = published.id;
  if (!mediaId) throw new Error("Instagram did not return published media id.");

  let permalink: string | undefined;
  try {
    const pu = new URL(`${GRAPH_BASE}/${mediaId}`);
    pu.searchParams.set("fields", "permalink");
    pu.searchParams.set("access_token", input.pageAccessToken);
    const pj = await graphJson<{ permalink?: string }>(pu.toString());
    permalink = pj.permalink;
  } catch {
    /* optional */
  }

  return { id: mediaId, permalink };
}
