import base64
import os
import re
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

import psycopg
from flask import Flask, g, jsonify, request
from psycopg.rows import dict_row

app = Flask(__name__)
DATABASE_URL = os.environ.get("DATABASE_URL")
MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
MAX_ATTACHMENTS_PER_MESSAGE = 8
ALLOWED_ATTACHMENT_TYPES = {
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
}

if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL must be configured for the chat API.")


def isoformat(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def connection() -> psycopg.Connection[dict[str, Any]]:
    if "db" not in g:
        g.db = psycopg.connect(DATABASE_URL, row_factory=dict_row)
    return g.db


@app.teardown_request
def close_db(error: BaseException | None) -> None:
    db = g.pop("db", None)
    if db is None:
        return
    try:
        if error is None:
            db.commit()
        else:
            db.rollback()
    finally:
        db.close()


def user_payload(row: dict[str, Any]) -> dict[str, str]:
    return {
        "id": row["id"],
        "email": row["email"],
        "displayName": row["display_name"],
    }


def message_payload(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "conversationId": row["conversation_id"],
        "senderId": row["sender_id"],
        "content": row["content"],
        "createdAt": isoformat(row["created_at"]),
        "attachments": row.get("attachments") or [],
    }


def attachment_payload(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "fileName": row["file_name"],
        "contentType": row["content_type"],
        "size": row["size"],
        "url": f"/api/storage/attachments/{row['id']}",
    }


def attachment_aggregate_sql() -> str:
    return """
        COALESCE(
          json_agg(json_build_object(
            'id', a.id,
            'fileName', a.file_name,
            'contentType', a.content_type,
            'size', a.size,
            'url', '/api/storage/attachments/' || a.id::text
          ) ORDER BY a.id) FILTER (WHERE a.id IS NOT NULL),
          '[]'::json
        )
    """


def validate_attachment_input(
    item: Any, user_id: str
) -> tuple[dict[str, Any] | None, str | None]:
    if not isinstance(item, dict):
        return None, "An attachment entry is invalid."

    object_path = item.get("objectPath")
    file_name = item.get("fileName")
    content_type = item.get("contentType")
    size = item.get("size")
    if not isinstance(object_path, str) or not isinstance(file_name, str):
        return None, "Attachment details are missing."
    if not isinstance(content_type, str) or not isinstance(size, int) or isinstance(size, bool):
        return None, "Attachment details are invalid."
    if size < 1 or size > MAX_ATTACHMENT_BYTES:
        return None, "Each attachment must be 25 MiB or smaller."

    normalized_type = content_type.split(";", 1)[0].strip().lower()
    if normalized_type not in ALLOWED_ATTACHMENT_TYPES:
        return None, "This attachment type is not supported."

    owner_prefix = f"/objects/uploads/{user_id}/"
    if not object_path.startswith(owner_prefix):
        return None, "Attachments must be uploaded by the signed-in user."
    object_id = object_path[len(owner_prefix):]
    if not re.fullmatch(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
        object_id,
        flags=re.IGNORECASE,
    ):
        return None, "The attachment reference is invalid."

    safe_name = re.sub(r"[\x00-\x1f\x7f/\\]", "_", file_name).strip()[:180]
    if not safe_name:
        safe_name = "attachment"
    return {
        "object_path": object_path,
        "file_name": safe_name,
        "content_type": normalized_type,
        "size": size,
    }, None


def ensure_current_user() -> dict[str, Any]:
    identity = g.chat_identity
    with connection().cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO chat_users (id, email, display_name)
            VALUES (%s, %s, %s)
            ON CONFLICT (id) DO UPDATE
              SET email = EXCLUDED.email,
                  display_name = EXCLUDED.display_name,
                  updated_at = NOW()
            RETURNING id, email, display_name
            """,
            (
                identity["id"],
                identity["email"],
                identity["display_name"],
            ),
        )
        return cursor.fetchone()


@app.before_request
def read_identity() -> Any:
    if request.path == "/healthz":
        return

    user_id = request.headers.get("X-Chat-User-Id", "").strip()
    if request.path.startswith("/internal/"):
        if not user_id:
            return jsonify({"error": "Internal authentication is required."}), 401
        g.chat_identity = {"id": user_id}
        return

    email = request.headers.get("X-Chat-Email", "").strip().lower()
    encoded_display_name = request.headers.get("X-Chat-Display-Name", "").strip()

    if not user_id or not email or not encoded_display_name:
        return jsonify({"error": "Authentication is required."}), 401
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        return jsonify({"error": "A verified account email is required."}), 401
    try:
        padding = "=" * (-len(encoded_display_name) % 4)
        display_name = base64.urlsafe_b64decode(
            encoded_display_name + padding
        ).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return jsonify({"error": "The account profile could not be read."}), 401

    g.chat_identity = {
        "id": user_id,
        "email": email,
        "display_name": display_name[:120],
    }
    try:
        g.chat_user = ensure_current_user()
    except psycopg.errors.UniqueViolation:
        connection().rollback()
        return jsonify({"error": "This email is already linked to another account."}), 409


@app.get("/healthz")
def health() -> tuple[Any, int]:
    return jsonify({"status": "ok"}), 200


@app.get("/internal/conversations/<int:conversation_id>/upload-access")
def internal_upload_access(conversation_id: int) -> Any:
    user_id = g.chat_identity["id"]
    with connection().cursor() as cursor:
        cursor.execute(
            """
            SELECT 1
            FROM chat_conversations
            WHERE id = %s
              AND (participant_one_id = %s OR participant_two_id = %s)
            """,
            (conversation_id, user_id, user_id),
        )
        if cursor.fetchone() is None:
            return jsonify({"error": "Conversation not found."}), 404
    return jsonify({"ok": True})


@app.get("/internal/conversations/<int:conversation_id>/call-access")
def internal_call_access(conversation_id: int) -> Any:
    user_id = g.chat_identity["id"]
    with connection().cursor() as cursor:
        cursor.execute(
            """
            SELECT
              caller.id AS caller_id,
              caller.email AS caller_email,
              caller.display_name AS caller_display_name,
              peer.id AS peer_id,
              peer.email AS peer_email,
              peer.display_name AS peer_display_name
            FROM chat_conversations c
            JOIN chat_users caller ON caller.id = %s
            JOIN chat_users peer ON peer.id = CASE
              WHEN c.participant_one_id = %s THEN c.participant_two_id
              ELSE c.participant_one_id
            END
            WHERE c.id = %s
              AND (c.participant_one_id = %s OR c.participant_two_id = %s)
            """,
            (user_id, user_id, conversation_id, user_id, user_id),
        )
        row = cursor.fetchone()
        if row is None:
            return jsonify({"error": "Conversation not found."}), 404

    return jsonify(
        {
            "caller": {
                "id": row["caller_id"],
                "email": row["caller_email"],
                "displayName": row["caller_display_name"],
            },
            "peer": {
                "id": row["peer_id"],
                "email": row["peer_email"],
                "displayName": row["peer_display_name"],
            },
        }
    )


@app.get("/internal/attachments/<int:attachment_id>/access")
def internal_attachment_access(attachment_id: int) -> Any:
    user_id = g.chat_identity["id"]
    with connection().cursor() as cursor:
        cursor.execute(
            """
            SELECT a.object_path, a.file_name, a.content_type, a.size
            FROM chat_attachments a
            JOIN chat_messages m ON m.id = a.message_id
            JOIN chat_conversations c ON c.id = m.conversation_id
            WHERE a.id = %s
              AND (c.participant_one_id = %s OR c.participant_two_id = %s)
            """,
            (attachment_id, user_id, user_id),
        )
        row = cursor.fetchone()
        if row is None:
            return jsonify({"error": "Attachment not found."}), 404
    return jsonify(
        {
            "objectPath": row["object_path"],
            "fileName": row["file_name"],
            "contentType": row["content_type"],
            "size": row["size"],
        }
    )


@app.get("/me")
def me() -> Any:
    return jsonify(user_payload(g.chat_user))


@app.get("/dashboard")
def dashboard() -> Any:
    user_id = g.chat_user["id"]
    with connection().cursor() as cursor:
        cursor.execute(
            """
            SELECT
              (SELECT COUNT(*) FROM chat_contacts WHERE owner_id = %s) AS contact_count,
              (SELECT COUNT(*) FROM chat_conversations
                 WHERE participant_one_id = %s OR participant_two_id = %s) AS conversation_count,
              (SELECT COUNT(*) FROM chat_messages m
                 JOIN chat_conversations c ON c.id = m.conversation_id
                 WHERE c.participant_one_id = %s OR c.participant_two_id = %s) AS message_count
            """,
            (user_id, user_id, user_id, user_id, user_id),
        )
        row = cursor.fetchone()
    return jsonify(
        {
            "contactCount": row["contact_count"],
            "conversationCount": row["conversation_count"],
            "messageCount": row["message_count"],
        }
    )


@app.get("/contacts")
def contacts() -> Any:
    with connection().cursor() as cursor:
        cursor.execute(
            """
            SELECT u.id, u.email, u.display_name
            FROM chat_contacts c
            JOIN chat_users u ON u.id = c.contact_id
            WHERE c.owner_id = %s
            ORDER BY LOWER(u.display_name), LOWER(u.email)
            """,
            (g.chat_user["id"],),
        )
        rows = cursor.fetchall()
    return jsonify([user_payload(row) for row in rows])


@app.post("/contacts")
def add_contact() -> Any:
    body = request.get_json(silent=True)
    email = body.get("email", "") if isinstance(body, dict) else ""
    if not isinstance(email, str):
        return jsonify({"error": "Enter a valid email address."}), 400
    email = email.strip().lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        return jsonify({"error": "Enter a valid email address."}), 400
    if email == g.chat_user["email"]:
        return jsonify({"error": "You cannot add your own account."}), 400

    owner_id = g.chat_user["id"]
    with connection().cursor() as cursor:
        cursor.execute(
            """
            SELECT id, email, display_name
            FROM chat_users
            WHERE email = %s
            """,
            (email,),
        )
        contact = cursor.fetchone()
        if contact is None:
            return jsonify({"error": "No account was found with that email."}), 404

        cursor.execute(
            """
            SELECT 1 FROM chat_contacts
            WHERE owner_id = %s AND contact_id = %s
            """,
            (owner_id, contact["id"]),
        )
        if cursor.fetchone() is not None:
            return jsonify({"error": "This person is already in your contacts."}), 409

        cursor.execute(
            """
            INSERT INTO chat_contacts (owner_id, contact_id)
            VALUES (%s, %s)
            ON CONFLICT (owner_id, contact_id) DO NOTHING
            """,
            (owner_id, contact["id"]),
        )
    return jsonify(user_payload(contact)), 201


def conversation_payload(cursor: Any, conversation: dict[str, Any], user_id: str) -> dict[str, Any]:
    contact_id = (
        conversation["participant_two_id"]
        if conversation["participant_one_id"] == user_id
        else conversation["participant_one_id"]
    )
    cursor.execute(
        """
        SELECT u.id, u.email, u.display_name,
               m.id AS message_id, m.conversation_id, m.sender_id,
               m.content, m.created_at AS message_created_at,
               COALESCE((
                 SELECT json_agg(json_build_object(
                   'id', a.id,
                   'fileName', a.file_name,
                   'contentType', a.content_type,
                   'size', a.size,
                   'url', '/api/storage/attachments/' || a.id::text
                 ) ORDER BY a.id)
                 FROM chat_attachments a
                 WHERE a.message_id = m.id
               ), '[]'::json) AS attachments,
               COALESCE(m.created_at, c.created_at) AS updated_at
        FROM chat_conversations c
        JOIN chat_users u ON u.id = %s
        LEFT JOIN LATERAL (
          SELECT id, conversation_id, sender_id, content, created_at
          FROM chat_messages
          WHERE conversation_id = c.id
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        ) m ON TRUE
        WHERE c.id = %s
        """,
        (contact_id, conversation["id"]),
    )
    row = cursor.fetchone()
    last_message = None
    if row["message_id"] is not None:
        last_message = {
            "id": row["message_id"],
            "conversationId": row["conversation_id"],
            "senderId": row["sender_id"],
            "content": row["content"],
            "createdAt": isoformat(row["message_created_at"]),
            "attachments": row["attachments"] or [],
        }
    return {
        "id": conversation["id"],
        "contact": user_payload(row),
        "lastMessage": last_message,
        "updatedAt": isoformat(row["updated_at"]),
    }


@app.get("/conversations")
def conversations() -> Any:
    user_id = g.chat_user["id"]
    with connection().cursor() as cursor:
        cursor.execute(
            """
            SELECT id, participant_one_id, participant_two_id, created_at
            FROM chat_conversations
            WHERE participant_one_id = %s OR participant_two_id = %s
            """,
            (user_id, user_id),
        )
        rows = cursor.fetchall()
        result = [
            conversation_payload(cursor, row, user_id)
            for row in rows
        ]
    result.sort(key=lambda item: item["updatedAt"], reverse=True)
    return jsonify(result)


@app.post("/conversations")
def create_conversation() -> Any:
    body = request.get_json(silent=True)
    contact_id = body.get("contactId") if isinstance(body, dict) else None
    if not isinstance(contact_id, str) or not contact_id.strip():
        return jsonify({"error": "Choose a contact to start a conversation."}), 400

    user_id = g.chat_user["id"]
    with connection().cursor() as cursor:
        cursor.execute(
            """
            SELECT 1 FROM chat_contacts
            WHERE owner_id = %s AND contact_id = %s
            """,
            (user_id, contact_id),
        )
        if cursor.fetchone() is None:
            return jsonify({"error": "Add this person as a contact first."}), 403

        participant_one_id, participant_two_id = sorted([user_id, contact_id])
        cursor.execute(
            """
            INSERT INTO chat_conversations (participant_one_id, participant_two_id)
            VALUES (%s, %s)
            ON CONFLICT (participant_one_id, participant_two_id) DO NOTHING
            RETURNING id, participant_one_id, participant_two_id, created_at
            """,
            (participant_one_id, participant_two_id),
        )
        conversation = cursor.fetchone()
        is_new = conversation is not None
        if conversation is None:
            cursor.execute(
                """
                SELECT id, participant_one_id, participant_two_id, created_at
                FROM chat_conversations
                WHERE participant_one_id = %s AND participant_two_id = %s
                """,
                (participant_one_id, participant_two_id),
            )
            conversation = cursor.fetchone()
        payload = conversation_payload(cursor, conversation, user_id)
    return jsonify(payload), 201 if is_new else 200


@app.get("/conversations/<int:conversation_id>/messages")
def messages(conversation_id: int) -> Any:
    user_id = g.chat_user["id"]
    with connection().cursor() as cursor:
        cursor.execute(
            """
            SELECT id, participant_one_id, participant_two_id
            FROM chat_conversations
            WHERE id = %s
              AND (participant_one_id = %s OR participant_two_id = %s)
            """,
            (conversation_id, user_id, user_id),
        )
        if cursor.fetchone() is None:
            return jsonify({"error": "Conversation not found."}), 404

        cursor.execute(
            """
            SELECT m.id, m.conversation_id, m.sender_id, m.content, m.created_at
            FROM chat_messages m
            WHERE m.conversation_id = %s
            ORDER BY m.created_at ASC, m.id ASC
            """,
            (conversation_id,),
        )
        rows = cursor.fetchall()
        attachments_by_message: dict[int, list[dict[str, Any]]] = defaultdict(list)
        if rows:
            message_ids = [row["id"] for row in rows]
            cursor.execute(
                """
                SELECT id, message_id, file_name, content_type, size
                FROM chat_attachments
                WHERE message_id = ANY(%s)
                ORDER BY id ASC
                """,
                (message_ids,),
            )
            for attachment in cursor.fetchall():
                attachments_by_message[attachment["message_id"]].append(
                    attachment_payload(attachment)
                )
    return jsonify(
        [
            message_payload(
                {**row, "attachments": attachments_by_message[row["id"]]}
            )
            for row in rows
        ]
    )


@app.post("/conversations/<int:conversation_id>/messages")
def send_message(conversation_id: int) -> Any:
    body = request.get_json(silent=True)
    content = body.get("content") if isinstance(body, dict) else None
    if not isinstance(content, str):
        return jsonify({"error": "Message text is invalid."}), 400
    content = content.strip()
    if len(content) > 4000:
        return jsonify({"error": "Messages must contain at most 4000 characters."}), 400

    raw_attachments = body.get("attachments", [])
    if not isinstance(raw_attachments, list) or len(raw_attachments) > MAX_ATTACHMENTS_PER_MESSAGE:
        return jsonify({"error": "A message can contain up to 8 attachments."}), 400

    user_id = g.chat_user["id"]
    attachments: list[dict[str, Any]] = []
    for item in raw_attachments:
        attachment, validation_error = validate_attachment_input(item, user_id)
        if validation_error:
            return jsonify({"error": validation_error}), 400
        if attachment is not None:
            attachments.append(attachment)
    if not content and not attachments:
        return jsonify({"error": "Write a message or attach a file before sending."}), 400

    with connection().cursor() as cursor:
        cursor.execute(
            """
            SELECT 1 FROM chat_conversations
            WHERE id = %s
              AND (participant_one_id = %s OR participant_two_id = %s)
            """,
            (conversation_id, user_id, user_id),
        )
        if cursor.fetchone() is None:
            return jsonify({"error": "Conversation not found."}), 404

        cursor.execute(
            """
            INSERT INTO chat_messages (conversation_id, sender_id, content)
            VALUES (%s, %s, %s)
            RETURNING id, conversation_id, sender_id, content, created_at
            """,
            (conversation_id, user_id, content),
        )
        message = cursor.fetchone()
        for attachment in attachments:
            cursor.execute(
                """
                INSERT INTO chat_attachments
                  (message_id, object_path, file_name, content_type, size)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (
                    message["id"],
                    attachment["object_path"],
                    attachment["file_name"],
                    attachment["content_type"],
                    attachment["size"],
                ),
            )
        cursor.execute(
            """
            SELECT id, file_name, content_type, size
            FROM chat_attachments
            WHERE message_id = %s
            ORDER BY id ASC
            """,
            (message["id"],),
        )
        message_attachments = [
            attachment_payload(row) for row in cursor.fetchall()
        ]
    return jsonify(
        message_payload({**message, "attachments": message_attachments})
    ), 201


if __name__ == "__main__":
    app.run(
        host="127.0.0.1",
        port=int(os.environ.get("CHAT_BACKEND_PORT", "8000")),
        debug=False,
        use_reloader=False,
    )
