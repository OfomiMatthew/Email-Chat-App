import { getAuth } from "@clerk/express";
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from "@workspace/api-zod";
import { Router, type IRouter, type Request, type Response } from "express";
import type { File } from "@google-cloud/storage";
import { getAttachmentFile, createAttachmentUpload } from "../lib/objectStorage";
import { requestChatBackend } from "../lib/chatBackend";

const router: IRouter = Router();
const maxAttachmentBytes = 25 * 1024 * 1024;
const allowedMimeTypes = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/heic",
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/ogg",
  "audio/aac",
  "audio/flac",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/x-wav",
  "application/pdf",
  "text/plain",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
]);

type AttachmentAccess = {
  objectPath: string;
  fileName: string;
  contentType: string;
  size: number;
};

function attachmentName(value: string): string {
  const normalized = value
    .replace(/[\/\\\u0000-\u001f\u007f]/g, "_")
    .trim()
    .slice(0, 180);
  return normalized || "attachment";
}

function contentDisposition(fileName: string, inline: boolean): string {
  const safeName = attachmentName(fileName).replace(/"/g, "'");
  return `${inline ? "inline" : "attachment"}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
}

function sendStorageResponse(
  req: Request,
  res: Response,
  file: File,
  contentType: string,
  fileName: string,
  size: number,
): void {
  const inline =
    contentType.startsWith("image/") ||
    contentType.startsWith("video/") ||
    contentType.startsWith("audio/") ||
    contentType === "application/pdf" ||
    contentType === "text/plain";

  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", contentDisposition(fileName, inline));
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; sandbox",
  );
  res.setHeader("Accept-Ranges", "bytes");

  const range = req.header("range");
  let start = 0;
  let end = size - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) {
      res.status(416).setHeader("Content-Range", `bytes */${size}`).end();
      return;
    }

    if (match[1]) {
      start = Number(match[1]);
      if (match[2]) end = Number(match[2]);
    } else {
      const suffixLength = Number(match[2]);
      start = Math.max(0, size - suffixLength);
    }

    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      start >= size
    ) {
      res.status(416).setHeader("Content-Range", `bytes */${size}`).end();
      return;
    }
    end = Math.min(end, size - 1);
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
  }

  res.setHeader("Content-Length", String(end - start + 1));
  const stream = file.createReadStream({ start, end });
  stream.on("error", (error) => {
    req.log.error({ err: error }, "Could not stream a private attachment");
    if (!res.headersSent) {
      res.status(500).json({ error: "Could not load this attachment." });
    } else {
      res.destroy(error);
    }
  });
  stream.pipe(res);
}

router.post(
  "/storage/uploads/request-url",
  async (req: Request, res: Response): Promise<void> => {
    const { userId } = getAuth(req);
    if (!userId) {
      res.status(401).json({ error: "Sign in to upload an attachment." });
      return;
    }

    const parsed = RequestUploadUrlBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid upload metadata." });
      return;
    }

    const { conversationId, name, size, contentType } = parsed.data;
    const normalizedType = contentType.toLowerCase().trim();
    if (
      size < 1 ||
      size > maxAttachmentBytes ||
      !allowedMimeTypes.has(normalizedType)
    ) {
      res.status(400).json({
        error: "Use a supported image, video, audio, or document under 25 MiB.",
      });
      return;
    }

    try {
      const permission = await requestChatBackend(
        `/internal/conversations/${conversationId}/upload-access`,
        userId,
      );
      if (permission.status === 404 || permission.status === 403) {
        res.status(403).json({
          error: "You can only upload to a conversation you belong to.",
        });
        return;
      }
      if (!permission.ok) {
        res.status(503).json({ error: "Could not verify this conversation." });
        return;
      }

      const upload = await createAttachmentUpload(userId);
      res.json(
        RequestUploadUrlResponse.parse({
          uploadURL: upload.uploadURL,
          objectPath: upload.objectPath,
        }),
      );
    } catch (error) {
      req.log.error({ err: error }, "Could not create a private upload URL");
      res.status(503).json({ error: "Private file uploads are unavailable." });
    }
  },
);

router.get(
  "/storage/attachments/:attachmentId",
  async (req: Request, res: Response): Promise<void> => {
    const { userId } = getAuth(req);
    if (!userId) {
      res.status(401).json({ error: "Sign in to view this attachment." });
      return;
    }

    const attachmentId = Number(req.params.attachmentId);
    if (!Number.isSafeInteger(attachmentId) || attachmentId < 1) {
      res.status(404).json({ error: "Attachment not found." });
      return;
    }

    try {
      const access = await requestChatBackend(
        `/internal/attachments/${attachmentId}/access`,
        userId,
      );
      if (access.status === 404 || access.status === 403) {
        res.status(404).json({ error: "Attachment not found." });
        return;
      }
      if (!access.ok) {
        res.status(503).json({ error: "Could not verify attachment access." });
        return;
      }

      const metadata = (await access.json()) as AttachmentAccess;
      const file = await getAttachmentFile(metadata.objectPath);
      if (!file) {
        res.status(404).json({ error: "Attachment file is unavailable." });
        return;
      }

      const [objectMetadata] = await file.getMetadata();
      const size = Number(objectMetadata.size ?? metadata.size);
      if (!Number.isSafeInteger(size) || size <= 0) {
        res.status(404).json({ error: "Attachment file is unavailable." });
        return;
      }
      sendStorageResponse(
        req,
        res,
        file,
        metadata.contentType,
        metadata.fileName,
        size,
      );
    } catch (error) {
      req.log.error({ err: error }, "Could not serve a private attachment");
      res.status(503).json({ error: "This attachment is temporarily unavailable." });
    }
  },
);

export default router;
