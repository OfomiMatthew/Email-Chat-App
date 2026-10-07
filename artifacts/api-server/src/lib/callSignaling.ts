import { verifyToken } from "@clerk/backend";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { requestChatBackend } from "./chatBackend";
import { logger } from "./logger";

type CallMode = "audio" | "video";
type ChatUser = { id: string; email: string; displayName: string };
type CallSocket = WebSocket;
type CallRecord = {
  callId: string;
  conversationId: number;
  callerId: string;
  calleeId: string;
  mode: CallMode;
  caller: ChatUser;
  peer: ChatUser;
  state: "ringing" | "active";
  callerSocket: CallSocket;
  calleeSocket?: CallSocket;
  timeout?: NodeJS.Timeout;
};
type SignalDescription = { type: "offer" | "answer"; sdp: string };
type SignalCandidate = {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
};
type ClientSignal = {
  type: "call:signal";
  callId: string;
  payload: {
    kind: "offer" | "answer" | "ice";
    description?: SignalDescription;
    candidate?: SignalCandidate;
  };
};
const websocketProtocol = "email-chat";
const socketsByUser = new Map<string, Set<CallSocket>>();
const socketOwners = new WeakMap<CallSocket, string>();
const callsById = new Map<string, CallRecord>();
const callsByUser = new Map<string, string>();
const callsByConversation = new Map<number, string>();
const pendingStarts = new Set<string>();

function send(socket: CallSocket, message: Record<string, unknown>): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function sendToUser(userId: string, message: Record<string, unknown>): void {
  for (const socket of socketsByUser.get(userId) ?? []) {
    send(socket, message);
  }
}

function finishCall(call: CallRecord, reason: string): void {
  if (!callsById.has(call.callId)) return;
  if (call.timeout) clearTimeout(call.timeout);
  callsById.delete(call.callId);
  callsByUser.delete(call.callerId);
  callsByUser.delete(call.calleeId);
  callsByConversation.delete(call.conversationId);
  const message = {
    type: "call:ended",
    callId: call.callId,
    conversationId: call.conversationId,
    reason,
  };
  sendToUser(call.callerId, message);
  sendToUser(call.calleeId, message);
}

function closeUpgrade(socket: Duplex, status: number, label: string): void {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function parseProtocols(request: IncomingMessage): string[] {
  const header = request.headers["sec-websocket-protocol"];
  if (!header) return [];
  return header.split(",").map((protocol) => protocol.trim());
}

async function authenticateUpgrade(
  request: IncomingMessage,
): Promise<string | null> {
  const protocols = parseProtocols(request);
  const tokenProtocol = protocols.find((protocol) =>
    protocol.startsWith("auth."),
  );
  if (!protocols.includes(websocketProtocol) || !tokenProtocol) return null;
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    logger.error("CLERK_SECRET_KEY is required for call signaling");
    return null;
  }

  try {
    const verification = await verifyToken(tokenProtocol.slice("auth.".length), {
      secretKey,
    });
    const claims = verification.data as { sub?: unknown } | undefined;
    if (typeof claims?.sub !== "string") return null;
    return claims.sub;
  } catch {
    return null;
  }
}

function isCallMode(value: unknown): value is CallMode {
  return value === "audio" || value === "video";
}

function parseCallSignal(value: unknown): ClientSignal["payload"] | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  const description =
    payload.description && typeof payload.description === "object"
      ? (payload.description as Record<string, unknown>)
      : null;
  const candidate =
    payload.candidate && typeof payload.candidate === "object"
      ? (payload.candidate as Record<string, unknown>)
      : null;
  if (
    payload.kind === "offer" &&
    description?.type === "offer" &&
    typeof description.sdp === "string" &&
    description.sdp.length <= 20_000
  ) {
    return {
      kind: "offer",
      description: { type: "offer", sdp: description.sdp },
    };
  }
  if (
    payload.kind === "answer" &&
    description?.type === "answer" &&
    typeof description.sdp === "string" &&
    description.sdp.length <= 20_000
  ) {
    return {
      kind: "answer",
      description: { type: "answer", sdp: description.sdp },
    };
  }
  if (
    payload.kind === "ice" &&
    typeof candidate?.candidate === "string" &&
    candidate.candidate.length <= 4_096
  ) {
    return {
      kind: "ice",
      candidate: {
        candidate: candidate.candidate,
        sdpMid:
          typeof candidate.sdpMid === "string" || candidate.sdpMid === null
            ? candidate.sdpMid
            : undefined,
        sdpMLineIndex:
          typeof candidate.sdpMLineIndex === "number" ||
          candidate.sdpMLineIndex === null
            ? candidate.sdpMLineIndex
            : undefined,
        usernameFragment:
          typeof candidate.usernameFragment === "string" ||
          candidate.usernameFragment === null
            ? candidate.usernameFragment
            : undefined,
      },
    };
  }
  return null;
}

async function startCall(
  socket: CallSocket,
  callerId: string,
  message: Record<string, unknown>,
): Promise<void> {
  const conversationId = Number(message.conversationId);
  if (!Number.isSafeInteger(conversationId) || conversationId < 1) {
    send(socket, { type: "call:error", message: "Choose a valid conversation." });
    return;
  }
  if (!isCallMode(message.mode)) {
    send(socket, { type: "call:error", message: "Choose audio or video." });
    return;
  }

  const existingCallId = callsByUser.get(callerId);
  if (
    existingCallId ||
    pendingStarts.has(callerId) ||
    callsByConversation.has(conversationId)
  ) {
    send(socket, { type: "call:unavailable", conversationId, reason: "busy" });
    return;
  }

  pendingStarts.add(callerId);
  try {
    const access = await requestChatBackend(
      `/internal/conversations/${conversationId}/call-access`,
      callerId,
    );
    if (!access.ok) {
      send(socket, {
        type: "call:error",
        message: "You can only call someone in one of your conversations.",
      });
      return;
    }
    const participants = (await access.json()) as {
      caller: ChatUser;
      peer: ChatUser;
    };
    const { caller, peer } = participants;
    if (caller.id !== callerId || !peer.id) {
      send(socket, { type: "call:error", message: "Conversation access failed." });
      return;
    }

    if (
      callsByUser.has(callerId) ||
      callsByUser.has(peer.id) ||
      callsByConversation.has(conversationId)
    ) {
      send(socket, { type: "call:unavailable", conversationId, reason: "busy" });
      return;
    }

    if (!socketsByUser.get(peer.id)?.size) {
      send(socket, { type: "call:unavailable", conversationId, reason: "offline" });
      return;
    }
    if (callsByUser.has(peer.id)) {
      send(socket, { type: "call:unavailable", conversationId, reason: "busy" });
      return;
    }
    if (socket.readyState !== WebSocket.OPEN) return;

    const call: CallRecord = {
      callId: randomUUID(),
      conversationId,
      callerId,
      calleeId: peer.id,
      mode: message.mode,
      caller,
      peer,
      state: "ringing",
      callerSocket: socket,
    };
    callsById.set(call.callId, call);
    callsByUser.set(callerId, call.callId);
    callsByUser.set(peer.id, call.callId);
    callsByConversation.set(conversationId, call.callId);
    call.timeout = setTimeout(() => finishCall(call, "no-answer"), 35_000);

    send(socket, {
      type: "call:started",
      callId: call.callId,
      conversationId,
      mode: call.mode,
      contact: call.peer,
    });
    sendToUser(peer.id, {
      type: "call:incoming",
      callId: call.callId,
      conversationId,
      mode: call.mode,
      contact: call.caller,
    });
  } catch (error) {
    logger.error({ err: error }, "Could not authorize a call");
    send(socket, {
      type: "call:error",
      message: "Calls are temporarily unavailable.",
    });
  } finally {
    pendingStarts.delete(callerId);
  }
}

async function handleClientMessage(
  socket: CallSocket,
  userId: string,
  rawMessage: RawData,
): Promise<void> {
  let message: unknown;
  try {
    message = JSON.parse(rawMessage.toString());
  } catch {
    send(socket, { type: "call:error", message: "Invalid call message." });
    return;
  }
  if (!message || typeof message !== "object") {
    send(socket, { type: "call:error", message: "Invalid call message." });
    return;
  }

  const payload = message as Record<string, unknown>;
  if (payload.type === "call:start") {
    await startCall(socket, userId, payload);
    return;
  }
  if (typeof payload.callId !== "string") {
    send(socket, { type: "call:error", message: "Call reference is missing." });
    return;
  }

  const call = callsById.get(payload.callId);
  if (
    !call ||
    (call.callerId !== userId && call.calleeId !== userId)
  ) {
    send(socket, { type: "call:error", message: "This call is no longer active." });
    return;
  }

  if (payload.type === "call:accept") {
    if (userId !== call.calleeId || call.state !== "ringing") return;
    if (call.timeout) clearTimeout(call.timeout);
    call.state = "active";
    call.calleeSocket = socket;
    const accepted = {
      type: "call:accepted",
      callId: call.callId,
      conversationId: call.conversationId,
      mode: call.mode,
      callerId: call.callerId,
      calleeId: call.calleeId,
    };
    send(call.callerSocket, accepted);
    send(socket, accepted);
    for (const peerSocket of socketsByUser.get(call.calleeId) ?? []) {
      if (peerSocket !== socket) {
        send(peerSocket, {
          type: "call:answered-elsewhere",
          callId: call.callId,
        });
      }
    }
    return;
  }

  if (payload.type === "call:decline") {
    if (userId === call.calleeId && call.state === "ringing") {
      finishCall(call, "declined");
    }
    return;
  }

  if (payload.type === "call:hangup") {
    finishCall(call, "hangup");
    return;
  }

  if (payload.type === "call:signal") {
    if (call.state !== "active") return;
    const signal = parseCallSignal(payload.payload);
    if (!signal) {
      send(socket, { type: "call:error", message: "Invalid call signal." });
      return;
    }
    const recipientId = userId === call.callerId ? call.calleeId : call.callerId;
    const recipientSocket =
      recipientId === call.callerId ? call.callerSocket : call.calleeSocket;
    if (!recipientSocket || recipientSocket.readyState !== WebSocket.OPEN) {
      finishCall(call, "disconnected");
      return;
    }
    send(recipientSocket, {
      type: "call:signal",
      callId: call.callId,
      payload: signal,
    });
  }
}

export function attachCallSignaling(server: HttpServer): void {
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    handleProtocols(protocols) {
      return protocols.has(websocketProtocol) ? websocketProtocol : false;
    },
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname !== "/ws") {
      closeUpgrade(socket, 404, "Not Found");
      return;
    }

    void authenticateUpgrade(request).then((userId) => {
      if (!userId) {
        closeUpgrade(socket, 401, "Unauthorized");
        return;
      }

      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        socketOwners.set(websocket, userId);
        websocketServer.emit("connection", websocket, request);
      });
    });
  });

  websocketServer.on("connection", (socket) => {
    const userId = socketOwners.get(socket);
    if (!userId) {
      socket.close(1008, "Authentication required");
      return;
    }

    let userSockets = socketsByUser.get(userId);
    if (!userSockets) {
      userSockets = new Set();
      socketsByUser.set(userId, userSockets);
    }
    userSockets.add(socket);

    socket.on("message", (message) => {
      void handleClientMessage(socket, userId, message);
    });
    socket.on("error", (error) => {
      logger.warn({ err: error, userId }, "Call signaling socket error");
    });
    socket.on("close", () => {
      const currentSockets = socketsByUser.get(userId);
      currentSockets?.delete(socket);
      if (!currentSockets?.size) socketsByUser.delete(userId);
      for (const call of callsById.values()) {
        if (call.callerSocket === socket || call.calleeSocket === socket) {
          finishCall(call, "disconnected");
        }
      }
    });
  });
}
