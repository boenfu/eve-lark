import { createLarkChannel } from "eve-lark";

// Mount the Lark/Feishu channel. Reads credentials from env so the same
// build runs locally and in production.
export default createLarkChannel({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  verificationToken: process.env.LARK_VERIFICATION_TOKEN,
  encryptKey: process.env.LARK_ENCRYPT_KEY,
  botOpenId: process.env.LARK_BOT_OPEN_ID,
  baseUrl: process.env.LARK_BASE_URL ?? "https://open.feishu.cn",
  webhookPath: "/lark/webhook",
  replyMode: (process.env.LARK_REPLY_MODE as "streaming" | "static" | undefined) ?? "streaming",
});
