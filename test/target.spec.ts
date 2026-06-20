import { describe, expect, it } from "vitest";
import {
  encodeLarkRouteTarget,
  resolveLarkOutboundTarget,
} from "../src/target.js";

describe("Lark outbound target helpers", () => {
  it("infers receive_id_type from native and tagged targets", () => {
    expect(resolveLarkOutboundTarget({ to: "oc_chat" })).toMatchObject({
      receiveId: "oc_chat",
      receiveIdType: "chat_id",
    });
    expect(resolveLarkOutboundTarget({ to: "open_id:ou_user" })).toMatchObject({
      receiveId: "ou_user",
      receiveIdType: "open_id",
    });
    expect(resolveLarkOutboundTarget({ to: "user:user_123" })).toMatchObject({
      receiveId: "user_123",
      receiveIdType: "user_id",
    });
  });

  it("accepts explicit target objects for open_id and user_id sends", () => {
    expect(resolveLarkOutboundTarget({
      to: { id: "ou_user", idType: "open_id" },
    })).toMatchObject({
      receiveId: "ou_user",
      receiveIdType: "open_id",
    });
    expect(resolveLarkOutboundTarget({
      to: { id: "employee123", idType: "user_id" },
    })).toMatchObject({
      receiveId: "employee123",
      receiveIdType: "user_id",
    });
  });

  it("round-trips encoded reply and thread route metadata", () => {
    const encoded = encodeLarkRouteTarget({
      target: "oc_chat",
      replyToMessageId: "om_root:synthetic_suffix",
      threadId: "thread_1",
    });

    expect(encoded).toBe(
      "oc_chat#__feishu_reply_to=om_root&__feishu_thread_id=thread_1",
    );
    expect(resolveLarkOutboundTarget({ to: encoded })).toMatchObject({
      receiveId: "oc_chat",
      receiveIdType: "chat_id",
      rootId: "om_root",
      threadId: "thread_1",
    });
  });

  it("prefers explicit reply metadata over encoded target metadata", () => {
    expect(resolveLarkOutboundTarget({
      to: "oc_chat#__feishu_reply_to=om_encoded",
      rootId: "om_explicit",
      parentId: "om_parent",
    })).toMatchObject({
      receiveId: "oc_chat",
      rootId: "om_explicit",
      parentId: "om_parent",
    });
  });
});
