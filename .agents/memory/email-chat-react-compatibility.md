---
name: Email Chat React compatibility
description: Why Email Chat uses a local React patch instead of the workspace catalog.
---

Keep `react` and `react-dom` at 19.1.4 in Email Chat. The shared workspace catalog remains at 19.1.0 for Expo compatibility, while the installed Clerk React packages require the newer patch.

**Why:** using the shared version produced peer dependency warnings; changing the shared catalog could affect future Expo packages.

**How to apply:** keep the override scoped to Email Chat unless Clerk's peer range and the workspace's Expo constraints are rechecked.
