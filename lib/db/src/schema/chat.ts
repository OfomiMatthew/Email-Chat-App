import {
  index,
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const chatUsersTable = pgTable(
  "chat_users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    displayName: text("display_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
);

export const chatContactsTable = pgTable(
  "chat_contacts",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => chatUsersTable.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => chatUsersTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.contactId] }),
    index("chat_contacts_contact_idx").on(table.contactId),
  ],
);

export const chatConversationsTable = pgTable(
  "chat_conversations",
  {
    id: serial("id").primaryKey(),
    participantOneId: text("participant_one_id")
      .notNull()
      .references(() => chatUsersTable.id, { onDelete: "cascade" }),
    participantTwoId: text("participant_two_id")
      .notNull()
      .references(() => chatUsersTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("chat_conversations_participants_unique").on(
      table.participantOneId,
      table.participantTwoId,
    ),
    index("chat_conversations_participant_two_idx").on(
      table.participantTwoId,
    ),
  ],
);

export const chatMessagesTable = pgTable(
  "chat_messages",
  {
    id: serial("id").primaryKey(),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => chatConversationsTable.id, { onDelete: "cascade" }),
    senderId: text("sender_id")
      .notNull()
      .references(() => chatUsersTable.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("chat_messages_conversation_created_idx").on(
      table.conversationId,
      table.createdAt,
    ),
  ],
);

export const insertChatUserSchema = createInsertSchema(chatUsersTable).omit({
  createdAt: true,
  updatedAt: true,
});
export const insertChatContactSchema = createInsertSchema(
  chatContactsTable,
).omit({ createdAt: true });
export const insertChatConversationSchema = createInsertSchema(
  chatConversationsTable,
).omit({ id: true, createdAt: true });
export const insertChatMessageSchema = createInsertSchema(
  chatMessagesTable,
).omit({ id: true, createdAt: true });

export type InsertChatUser = z.infer<typeof insertChatUserSchema>;
export type ChatUser = typeof chatUsersTable.$inferSelect;
export type InsertChatContact = z.infer<typeof insertChatContactSchema>;
export type ChatContact = typeof chatContactsTable.$inferSelect;
export type InsertChatConversation = z.infer<
  typeof insertChatConversationSchema
>;
export type ChatConversation = typeof chatConversationsTable.$inferSelect;
export type InsertChatMessage = z.infer<typeof insertChatMessageSchema>;
export type ChatMessage = typeof chatMessagesTable.$inferSelect;
