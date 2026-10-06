import base64
import os
import re
from datetime import datetime, timezone
from typing import Any

import psycopg
from flask import Flask, g, jsonify, request
from psycopg.rows import dict_row

app = Flask(__name__)
DATABASE_URL = os.environ.get("DATABASE_URL")

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
    }


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
            SELECT id, conversation_id, sender_id, content, created_at
            FROM chat_messages
            WHERE conversation_id = %s
            ORDER BY created_at ASC, id ASC
            """,
            (conversation_id,),
        )
        rows = cursor.fetchall()
    return jsonify([message_payload(row) for row in rows])


@app.post("/conversations/<int:conversation_id>/messages")
def send_message(conversation_id: int) -> Any:
    body = request.get_json(silent=True)
    content = body.get("content") if isinstance(body, dict) else None
    if not isinstance(content, str):
        return jsonify({"error": "Write a message before sending."}), 400
    content = content.strip()
    if not content or len(content) > 4000:
        return jsonify({"error": "Messages must contain 1 to 4000 characters."}), 400

    user_id = g.chat_user["id"]
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
    return jsonify(message_payload(message)), 201


if __name__ == "__main__":
    app.run(
        host="127.0.0.1",
        port=int(os.environ.get("CHAT_BACKEND_PORT", "8000")),
        debug=False,
        use_reloader=False,
    )
