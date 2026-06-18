import { eveChannel } from "eve/channels/eve";
import { localDev, placeholderAuth, vercelOidc } from "eve/channels/auth";

// Keep the built-in eve channel so the TUI / Vercel deployment still works
// alongside the Lark channel. Optional — delete this file if you only want
// Lark as the inbound surface.
export default eveChannel({
  auth: [localDev(), vercelOidc(), placeholderAuth()],
});
