export async function requestChatBackend(
  path: string,
  userId: string,
  init: RequestInit = {},
): Promise<Response> {
  if (!path.startsWith("/internal/")) {
    throw new Error("Only internal chat backend routes may be called here.");
  }

  const backendOrigin =
    process.env.CHAT_BACKEND_ORIGIN ?? "http://127.0.0.1:8000";
  const headers = new Headers(init.headers);
  headers.set("X-Chat-User-Id", userId);

  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  return fetch(new URL(path, backendOrigin), {
    ...init,
    headers,
    redirect: "manual",
  });
}
