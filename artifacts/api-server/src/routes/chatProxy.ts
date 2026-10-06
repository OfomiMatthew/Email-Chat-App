import { clerkClient, getAuth } from "@clerk/express";
import { Router, type IRouter, type Request, type Response } from "express";

type ChatIdentity = {
  id: string;
  email: string;
  displayName: string;
};

type CachedIdentity = ChatIdentity & { expiresAt: number };

const identityCache = new Map<string, CachedIdentity>();
const identityCacheDuration = 30_000;

const router: IRouter = Router();

function readCachedIdentity(id: string): ChatIdentity | undefined {
  const cached = identityCache.get(id);
  if (!cached) return undefined;
  if (cached.expiresAt < Date.now()) {
    identityCache.delete(id);
    return undefined;
  }
  return { id: cached.id, email: cached.email, displayName: cached.displayName };
}

async function getChatIdentity(id: string): Promise<ChatIdentity | null> {
  const cached = readCachedIdentity(id);
  if (cached) return cached;

  const user = await clerkClient.users.getUser(id);
  const email =
    user.primaryEmailAddress?.emailAddress ??
    user.emailAddresses[0]?.emailAddress ??
    "";
  if (!email) return null;

  const nameParts = [user.firstName, user.lastName].filter(
    (part): part is string => Boolean(part?.trim()),
  );
  const displayName =
    nameParts.join(" ").trim() || user.username?.trim() || email.split("@")[0];
  const identity: CachedIdentity = {
    id,
    email: email.trim().toLowerCase(),
    displayName,
    expiresAt: Date.now() + identityCacheDuration,
  };

  if (identityCache.size > 500) {
    for (const [cacheId, entry] of identityCache) {
      if (entry.expiresAt < Date.now()) identityCache.delete(cacheId);
    }
  }
  identityCache.set(id, identity);
  return { id, email: identity.email, displayName: identity.displayName };
}

async function requireChatIdentity(
  req: Request,
  res: Response,
  next: (error?: unknown) => void,
): Promise<void> {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Sign in to use chat." });
    return;
  }

  try {
    const identity = await getChatIdentity(userId);
    if (!identity) {
      res.status(403).json({ error: "A primary email is required for chat." });
      return;
    }
    res.locals.chatIdentity = identity;
    next();
  } catch (error) {
    req.log.error({ err: error }, "Could not load the signed-in chat profile");
    res.status(503).json({ error: "The chat profile is temporarily unavailable." });
  }
}

router.use(requireChatIdentity);

router.use(async (req, res): Promise<void> => {
  const backendOrigin =
    process.env.CHAT_BACKEND_ORIGIN ?? "http://127.0.0.1:8000";
  const apiRelativeUrl = req.originalUrl.replace(/^\/api(?=\/|\?)/, "") || "/";
  const target = new URL(apiRelativeUrl, backendOrigin);
  const identity = res.locals.chatIdentity as ChatIdentity;
  const headers = new Headers({
    "X-Chat-User-Id": identity.id,
    "X-Chat-Email": identity.email,
    "X-Chat-Display-Name": Buffer.from(identity.displayName, "utf8").toString(
      "base64url",
    ),
  });
  const contentType = req.get("content-type");
  if (contentType) headers.set("content-type", contentType);

  const init: RequestInit = {
    method: req.method,
    headers,
    redirect: "manual",
  };
  if (req.method !== "GET" && req.method !== "HEAD" && req.body !== undefined) {
    init.body = JSON.stringify(req.body);
  }

  try {
    const response = await fetch(target, init);
    const body = await response.text();
    res.status(response.status);
    res.setHeader(
      "content-type",
      response.headers.get("content-type") ?? "application/json",
    );
    res.send(body);
  } catch (error) {
    req.log.error({ err: error }, "Flask chat API request failed");
    res.status(502).json({ error: "The chat service is temporarily unavailable." });
  }
});

export default router;
