import { handlePolystellaBatchQueue } from "@cloudflare/polystella-emdash/queue";
import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";

export { PluginBridge };

export default {
  ...handler,
  scheduled: createScheduledHandler(),
  queue: handlePolystellaBatchQueue,
};
