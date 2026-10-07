import { randomUUID } from "node:crypto";
import { Storage, type File } from "@google-cloud/storage";

const SIDECAR_ENDPOINT = "http://127.0.0.1:1106";
const storage = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${SIDECAR_ENDPOINT}/credential`,
      format: {
        type: "json",
        subject_token_field_name: "access_token",
      },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

function getPrivateObjectDir(): string {
  const directory = process.env.PRIVATE_OBJECT_DIR?.trim();
  if (!directory) {
    throw new Error("Private object storage is not configured.");
  }
  return directory.replace(/\/+$/, "");
}

function parseBucketPath(path: string): {
  bucketName: string;
  objectName: string;
} {
  const segments = path.split("/").filter(Boolean);
  if (segments.length < 2) {
    throw new Error("Invalid private object storage path.");
  }
  return {
    bucketName: segments[0],
    objectName: segments.slice(1).join("/"),
  };
}

function isValidAttachmentPath(path: string): boolean {
  return /^\/objects\/uploads\/[A-Za-z0-9_-]{1,100}\/[0-9a-f-]{36}$/i.test(
    path,
  );
}

export async function createAttachmentUpload(
  ownerId: string,
): Promise<{ uploadURL: string; objectPath: string }> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(ownerId)) {
    throw new Error("Invalid attachment owner.");
  }

  const objectId = randomUUID();
  const entityPath = `uploads/${ownerId}/${objectId}`;
  const { bucketName, objectName } = parseBucketPath(
    `${getPrivateObjectDir()}/${entityPath}`,
  );
  const request = {
    bucket_name: bucketName,
    object_name: objectName,
    method: "PUT",
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  };
  const response = await fetch(
    `${SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    },
  );

  if (!response.ok) {
    throw new Error(`Private storage could not sign the upload (${response.status}).`);
  }

  const payload = (await response.json()) as { signed_url?: unknown };
  if (typeof payload.signed_url !== "string") {
    throw new Error("Private storage returned an invalid upload URL.");
  }

  return {
    uploadURL: payload.signed_url,
    objectPath: `/objects/${entityPath}`,
  };
}

export async function getAttachmentFile(
  objectPath: string,
): Promise<File | null> {
  if (!isValidAttachmentPath(objectPath)) return null;

  const entityPath = objectPath.slice("/objects/".length);
  const { bucketName, objectName } = parseBucketPath(
    `${getPrivateObjectDir()}/${entityPath}`,
  );
  const file = storage.bucket(bucketName).file(objectName);
  const [exists] = await file.exists();
  return exists ? file : null;
}
