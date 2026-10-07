import { useAuth } from "@clerk/react";
import { useEffect, useRef, useState } from "react";

export type CallMode = "audio" | "video";
export type CallContact = { id: string; email: string; displayName: string };
export type CallInfo = {
  callId: string;
  conversationId: number;
  mode: CallMode;
  phase: "incoming" | "ringing" | "connecting" | "connected";
  contact: CallContact;
};

type CallRole = "caller" | "callee";
type LiveCall = CallInfo & { role: CallRole };
type SignalPayload =
  | { kind: "offer" | "answer"; description: RTCSessionDescriptionInit }
  | { kind: "ice"; candidate: RTCIceCandidateInit };
type ServerMessage = Record<string, unknown>;

const webSocketBase = import.meta.env.BASE_URL.replace(/\/$/, "");

export function useCallSession() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const [call, setCall] = useState<LiveCall | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [isMicrophoneEnabled, setIsMicrophoneEnabled] = useState(true);
  const [isCameraEnabled, setIsCameraEnabled] = useState(true);
  const [connectionStatus, setConnectionStatus] = useState("Connecting to calls");
  const [error, setError] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const callRef = useRef<LiveCall | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const pendingStartRef = useRef<{
    conversationId: number;
    contact: CallContact;
    mode: CallMode;
  } | null>(null);
  const disposedRef = useRef(false);

  const updateCall = (next: LiveCall | null) => {
    callRef.current = next;
    setCall(next);
  };

  const send = (message: Record<string, unknown>): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  };

  const stopMedia = () => {
    peerRef.current?.close();
    peerRef.current = null;
    for (const track of localStreamRef.current?.getTracks() ?? []) track.stop();
    localStreamRef.current = null;
    remoteStreamRef.current = null;
    pendingCandidatesRef.current = [];
    setLocalStream(null);
    setRemoteStream(null);
    setIsMicrophoneEnabled(true);
    setIsCameraEnabled(true);
  };

  const closeCurrentCall = () => {
    stopMedia();
    updateCall(null);
    pendingStartRef.current = null;
    setConnectionStatus(
      socketRef.current?.readyState === WebSocket.OPEN
        ? "Call service ready"
        : "Reconnecting to calls",
    );
  };

  const ensurePeerConnection = (): RTCPeerConnection => {
    if (peerRef.current) return peerRef.current;
    const peer = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    peerRef.current = peer;

    for (const track of localStreamRef.current?.getTracks() ?? []) {
      peer.addTrack(track, localStreamRef.current as MediaStream);
    }

    peer.onicecandidate = (event) => {
      const activeCall = callRef.current;
      if (!event.candidate || !activeCall) return;
      send({
        type: "call:signal",
        callId: activeCall.callId,
        payload: { kind: "ice", candidate: event.candidate.toJSON() },
      });
    };
    peer.ontrack = (event) => {
      const stream =
        event.streams[0] ?? remoteStreamRef.current ?? new MediaStream();
      if (!event.streams[0]) stream.addTrack(event.track);
      remoteStreamRef.current = stream;
      setRemoteStream(stream);
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "connected") {
        setConnectionStatus("Connected");
        const activeCall = callRef.current;
        if (activeCall) updateCall({ ...activeCall, phase: "connected" });
      } else if (
        peer.connectionState === "disconnected" ||
        peer.connectionState === "connecting"
      ) {
        setConnectionStatus(
          peer.connectionState === "disconnected"
            ? "Trying to reconnect"
            : "Connecting",
        );
      } else if (peer.connectionState === "failed") {
        setError("The call connection failed. Try again on a different network.");
        send({
          type: "call:hangup",
          callId: callRef.current?.callId,
        });
        closeCurrentCall();
      }
    };
    return peer;
  };

  const flushPendingCandidates = async (peer: RTCPeerConnection) => {
    if (!peer.remoteDescription) return;
    const pending = pendingCandidatesRef.current.splice(0);
    for (const candidate of pending) {
      try {
        await peer.addIceCandidate(candidate);
      } catch {
        // An expired candidate can be ignored; later candidates still recover the connection.
      }
    }
  };

  const handleSignal = async (
    callId: string,
    payload: SignalPayload,
  ): Promise<void> => {
    const activeCall = callRef.current;
    if (!activeCall || activeCall.callId !== callId) return;
    try {
      const peer = ensurePeerConnection();
      if (payload.kind === "ice") {
        if (peer.remoteDescription) {
          await peer.addIceCandidate(payload.candidate);
        } else {
          pendingCandidatesRef.current.push(payload.candidate);
        }
        return;
      }

      await peer.setRemoteDescription(payload.description);
      await flushPendingCandidates(peer);
      if (payload.kind === "offer" && activeCall.role === "callee") {
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        send({
          type: "call:signal",
          callId,
          payload: {
            kind: "answer",
            description: peer.localDescription,
          },
        });
      }
    } catch {
      setError("The call could not establish a media connection.");
      send({ type: "call:hangup", callId });
      closeCurrentCall();
    }
  };

  const handleServerMessage = (raw: string) => {
    let message: ServerMessage;
    try {
      message = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }

    if (message.type === "call:started") {
      const pending = pendingStartRef.current;
      const current = callRef.current;
      if (
        !pending ||
        !current ||
        message.conversationId !== pending.conversationId
      ) {
        if (typeof message.callId === "string") {
          send({ type: "call:hangup", callId: message.callId });
        }
        return;
      }
      const next: LiveCall = {
        ...current,
        callId: String(message.callId),
        phase: "ringing",
        role: "caller",
        contact: (message.contact as CallContact) ?? pending.contact,
      };
      updateCall(next);
      pendingStartRef.current = null;
      setConnectionStatus("Waiting for them to answer");
      return;
    }

    if (message.type === "call:incoming") {
      const activeCall = callRef.current;
      if (activeCall) {
        send({ type: "call:decline", callId: message.callId });
        return;
      }
      const contact = message.contact as CallContact | undefined;
      if (!contact || !message.callId) return;
      updateCall({
        callId: String(message.callId),
        conversationId: Number(message.conversationId),
        mode: message.mode === "video" ? "video" : "audio",
        phase: "incoming",
        contact,
        role: "callee",
      });
      setError(null);
      setConnectionStatus("Incoming call");
      return;
    }

    if (message.type === "call:accepted") {
      const activeCall = callRef.current;
      if (!activeCall || activeCall.callId !== message.callId) return;
      updateCall({ ...activeCall, phase: "connecting" });
      setConnectionStatus("Connecting");
      const peer = ensurePeerConnection();
      if (activeCall.role === "caller") {
        void (async () => {
          try {
            const offer = await peer.createOffer();
            await peer.setLocalDescription(offer);
            send({
              type: "call:signal",
              callId: activeCall.callId,
              payload: {
                kind: "offer",
                description: peer.localDescription,
              },
            });
          } catch {
            setError("Could not start the media connection.");
            send({ type: "call:hangup", callId: activeCall.callId });
            closeCurrentCall();
          }
        })();
      }
      return;
    }

    if (message.type === "call:answered-elsewhere") {
      const activeCall = callRef.current;
      if (
        activeCall &&
        activeCall.callId === message.callId &&
        activeCall.role === "callee" &&
        activeCall.phase === "incoming"
      ) {
        closeCurrentCall();
      }
      return;
    }

    if (message.type === "call:signal") {
      const payload = message.payload as SignalPayload | undefined;
      if (typeof message.callId === "string" && payload?.kind) {
        void handleSignal(message.callId, payload);
      }
      return;
    }

    if (message.type === "call:unavailable") {
      const pending = pendingStartRef.current;
      if (pending && pending.conversationId === message.conversationId) {
        setError(
          message.reason === "offline"
            ? "This person is not online right now."
            : "This person is already on a call.",
        );
        closeCurrentCall();
      }
      return;
    }

    if (message.type === "call:ended") {
      if (callRef.current?.callId !== message.callId) return;
      if (message.reason === "declined") setError("The call was declined.");
      else if (message.reason === "no-answer") setError("There was no answer.");
      else if (message.reason === "disconnected") {
        setError("The other person disconnected.");
      }
      closeCurrentCall();
      return;
    }

    if (message.type === "call:error" && typeof message.message === "string") {
      setError(message.message);
    }
  };

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    disposedRef.current = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 500;
    let activeSocket: WebSocket | null = null;

    const scheduleReconnect = () => {
      if (disposedRef.current || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        void connect();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 10_000);
    };

    const connect = async () => {
      if (disposedRef.current) return;
      try {
        const token = await getToken();
        if (!token || disposedRef.current) {
          scheduleReconnect();
          return;
        }
        const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
        const url = `${scheme}//${window.location.host}${webSocketBase}/ws`;
        const socket = new WebSocket(url, ["email-chat", `auth.${token}`]);
        activeSocket = socket;
        socketRef.current = socket;
        socket.onopen = () => {
          retryDelay = 500;
          setConnectionStatus("Call service ready");
        };
        socket.onmessage = (event) => handleServerMessage(String(event.data));
        socket.onerror = () => socket.close();
        socket.onclose = () => {
          if (socketRef.current === socket) socketRef.current = null;
          setConnectionStatus("Reconnecting to calls");
          if (callRef.current && !callRef.current.callId.startsWith("pending-")) {
            setError("The call connection was interrupted.");
            closeCurrentCall();
          }
          scheduleReconnect();
        };
      } catch {
        setConnectionStatus("Reconnecting to calls");
        scheduleReconnect();
      }
    };

    void connect();
    return () => {
      disposedRef.current = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (activeSocket && activeSocket.readyState < WebSocket.CLOSING) {
        activeSocket.close();
      }
      if (socketRef.current === activeSocket) socketRef.current = null;
      stopMedia();
      callRef.current = null;
      setCall(null);
    };
  }, [getToken, isLoaded, isSignedIn]);

  const getLocalMedia = async (mode: CallMode): Promise<MediaStream> => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Your browser does not support voice or video calls.");
    }
    return navigator.mediaDevices.getUserMedia({
      audio: true,
      video: mode === "video",
    });
  };

  const startCall = async (
    conversationId: number,
    contact: CallContact,
    mode: CallMode,
  ) => {
    if (callRef.current) return;
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      setError("Call service is reconnecting. Try again in a moment.");
      return;
    }
    setError(null);
    setConnectionStatus("Requesting microphone and camera");
    try {
      const stream = await getLocalMedia(mode);
      localStreamRef.current = stream;
      setLocalStream(stream);
      setIsMicrophoneEnabled(true);
      setIsCameraEnabled(mode === "video");
      const provisionalId = `pending-${crypto.randomUUID()}`;
      pendingStartRef.current = { conversationId, contact, mode };
      updateCall({
        callId: provisionalId,
        conversationId,
        mode,
        phase: "ringing",
        contact,
        role: "caller",
      });
      setConnectionStatus("Calling");
      if (!send({ type: "call:start", conversationId, mode })) {
        throw new Error("Call service disconnected before the call started.");
      }
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not access the microphone or camera.",
      );
      closeCurrentCall();
    }
  };

  const acceptCall = async () => {
    const current = callRef.current;
    if (!current || current.phase !== "incoming") return;
    setError(null);
    setConnectionStatus("Requesting microphone and camera");
    try {
      const stream = await getLocalMedia(current.mode);
      localStreamRef.current = stream;
      setLocalStream(stream);
      setIsMicrophoneEnabled(true);
      setIsCameraEnabled(current.mode === "video");
      updateCall({ ...current, phase: "connecting", role: "callee" });
      setConnectionStatus("Connecting");
      ensurePeerConnection();
      if (!send({ type: "call:accept", callId: current.callId })) {
        throw new Error("Call service disconnected before you could answer.");
      }
    } catch (caught) {
      send({ type: "call:decline", callId: current.callId });
      closeCurrentCall();
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not access the microphone or camera.",
      );
    }
  };

  const declineCall = () => {
    const current = callRef.current;
    if (!current) return;
    send({ type: "call:decline", callId: current.callId });
    closeCurrentCall();
  };

  const hangUp = () => {
    const current = callRef.current;
    if (!current) return;
    if (current.phase === "incoming") {
      send({ type: "call:decline", callId: current.callId });
    } else if (!current.callId.startsWith("pending-")) {
      send({ type: "call:hangup", callId: current.callId });
    }
    closeCurrentCall();
  };

  const toggleMicrophone = () => {
    const tracks = localStreamRef.current?.getAudioTracks() ?? [];
    if (tracks.length === 0) return;
    const enabled = !tracks[0].enabled;
    for (const track of tracks) track.enabled = enabled;
    setIsMicrophoneEnabled(enabled);
  };

  const toggleCamera = () => {
    const tracks = localStreamRef.current?.getVideoTracks() ?? [];
    if (tracks.length === 0) return;
    const enabled = !tracks[0].enabled;
    for (const track of tracks) track.enabled = enabled;
    setIsCameraEnabled(enabled);
  };

  const dismissError = () => setError(null);

  return {
    call,
    localStream,
    remoteStream,
    isMicrophoneEnabled,
    isCameraEnabled,
    connectionStatus,
    error,
    dismissError,
    startCall,
    acceptCall,
    declineCall,
    hangUp,
    toggleMicrophone,
    toggleCamera,
  };
}
